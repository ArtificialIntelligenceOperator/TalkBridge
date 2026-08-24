#!/usr/bin/env python3
"""
VoiceB local translation engine.

A WebSocket sidecar that turns a stream of microphone audio into a stream of
translated speech, entirely on this machine. It is the offline alternative to
gpt-realtime-translate: slower and turn-based rather than continuous, but free
and private.

The pipeline, per direction:

    16 kHz PCM  ->  VAD  ->  Whisper (ASR)  ->  OPUS-MT  ->  Piper (TTS)  ->  PCM

Each connection ("lane") builds its own engine — its own Whisper, its own
translation model, its own voice — and runs it on its own worker thread. The two
directions of a conversation therefore never queue behind one another: while
Whisper is chewing on what I just said, the other lane is free to synthesise
what the other person said. That costs roughly twice the RAM of a shared setup
and is the whole point.

Protocol, over ws://127.0.0.1:<port>/

    client -> server   binary   Int16 LE mono PCM at 16 kHz
    client -> server   text     {"type": "hello" | "mute" | "flush" | "config"}
    server -> client   text     {"type": "ready" | "partial" | "final"
                                 | "audio" | "speaking" | "lag" | "error"}

Audio comes back base64-encoded inside the JSON rather than as binary frames.
On loopback the extra third of a megabyte per minute costs nothing measurable,
and keeping one ordered stream of self-describing messages removes a whole class
of "which header did this buffer belong to" bugs.

Run standalone for a smoke test:
    python server.py --probe
    python server.py --download
    python server.py --port 0
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import shutil
import sys
import threading
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

import numpy as np

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[2]
MODELS = Path(os.environ.get("VOICEB_MODELS", ROOT / "models"))
WHISPER_DIR = MODELS / "whisper"
PIPER_DIR = MODELS / "piper"
MT_DIR = MODELS / "mt"
ASR_DIR = MODELS / "asr"

# Every download goes through the Hugging Face hub cache, and its default home
# is on the system drive — the one that is always the fullest. Point it at the
# models folder before anything imports huggingface_hub, so Parakeet's 2.4 GB
# lands next to everything else and not under the user profile. Set once,
# here, rather than relying on every caller remembering.
os.environ.setdefault("HF_HOME", str(MODELS / "hf"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

SAMPLE_RATE = 16000

# Whisper sizes we offer, smallest first. "turbo" is large-v3-turbo: much better
# than small and only about twice the cost, which on a six-core desktop is the
# difference between "fast" and "still faster than the speaker".
WHISPER_SIZES = ["tiny", "base", "small", "medium", "large-v3-turbo"]

# The recognisers that are not Whisper.
#
# Whisper pads every input to thirty seconds and runs its encoder over all of
# it, so a two-second remark costs the same as a paragraph — about 800 ms on
# this GPU. These two are FastConformer transducers: they process exactly the
# audio they are given, and on the *CPU* they come in at 150-300 ms. Measured
# on the user's own recordings they were also plainly more accurate, and they
# punctuate, which Whisper small barely does.
#
# GigaAM is Russian-only and the best thing available for it. Parakeet v3
# covers 25 European languages and is Parakeet's home turf in English.
# Whisper stays for everything else.
ASR_MODELS = {
    "gigaam": {
        "model": "gigaam-v3-e2e-rnnt",
        "languages": ["ru"],
        "label": "GigaAM v3",
    },
    "parakeet": {
        "model": "nemo-parakeet-tdt-0.6b-v3",
        "languages": ["bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de",
                      "el", "hu", "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk",
                      "sl", "es", "sv", "ru", "uk"],
        "label": "Parakeet TDT v3",
    },
}


def pick_asr(requested: str, language: str) -> str:
    """
    Resolves "auto" to a concrete recogniser for one language.

    The explicit choices pass straight through, so a user who picks Whisper
    gets Whisper. "auto" prefers the specialist: GigaAM for Russian, Parakeet
    where it speaks the language, Whisper as the backstop that speaks them all.
    """
    if requested and requested != "auto":
        return requested
    if language in ASR_MODELS["gigaam"]["languages"]:
        return "gigaam"
    if language in ASR_MODELS["parakeet"]["languages"]:
        return "parakeet"
    return "whisper"

# Piper voices on offer, per language. The first entry is the default.
#
# Medium and low quality only, on purpose. "high" sounds a little better and
# costs four and a half times as long to synthesise — 703 ms against 156 ms
# for one sentence on this machine — and every one of those milliseconds is
# added to the delay between the speaker and the translation. A phone call
# destroys the quality difference; nobody fails to notice the half second.
VOICE_CATALOG = {
    "en": [
        {"id": "en_US-ryan-medium", "name": "Ryan", "gender": "m", "accent": "US"},
        {"id": "en_US-joe-medium", "name": "Joe", "gender": "m", "accent": "US"},
        {"id": "en_US-john-medium", "name": "John", "gender": "m", "accent": "US"},
        {"id": "en_US-bryce-medium", "name": "Bryce", "gender": "m", "accent": "US"},
        {"id": "en_US-hfc_male-medium", "name": "HFC male", "gender": "m", "accent": "US"},
        {"id": "en_GB-alan-medium", "name": "Alan", "gender": "m", "accent": "UK"},
        {"id": "en_GB-northern_english_male-medium", "name": "Northern English",
         "gender": "m", "accent": "UK"},
        {"id": "en_US-amy-medium", "name": "Amy", "gender": "f", "accent": "US"},
        {"id": "en_US-lessac-medium", "name": "Lessac", "gender": "f", "accent": "US"},
        {"id": "en_US-hfc_female-medium", "name": "HFC female", "gender": "f", "accent": "US"},
        {"id": "en_US-kristin-medium", "name": "Kristin", "gender": "f", "accent": "US"},
        {"id": "en_GB-alba-medium", "name": "Alba", "gender": "f", "accent": "UK"},
        {"id": "en_GB-cori-medium", "name": "Cori", "gender": "f", "accent": "UK"},
        {"id": "en_GB-jenny_dioco-medium", "name": "Jenny", "gender": "f", "accent": "UK"},
    ],
    "ru": [
        {"id": "ru_RU-dmitri-medium", "name": "Дмитрий", "gender": "m"},
        {"id": "ru_RU-denis-medium", "name": "Денис", "gender": "m"},
        {"id": "ru_RU-ruslan-medium", "name": "Руслан", "gender": "m"},
        {"id": "ru_RU-irina-medium", "name": "Ирина", "gender": "f"},
    ],
    "de": [
        {"id": "de_DE-thorsten-medium", "name": "Thorsten", "gender": "m"},
        {"id": "de_DE-karlsson-low", "name": "Karlsson", "gender": "m"},
        {"id": "de_DE-kerstin-low", "name": "Kerstin", "gender": "f"},
        {"id": "de_DE-ramona-low", "name": "Ramona", "gender": "f"},
    ],
    "es": [
        {"id": "es_ES-davefx-medium", "name": "Davefx", "gender": "m", "accent": "ES"},
        {"id": "es_MX-ald-medium", "name": "Ald", "gender": "m", "accent": "MX"},
        {"id": "es_ES-mls_9972-low", "name": "MLS 9972", "gender": "f", "accent": "ES"},
    ],
    "fr": [
        {"id": "fr_FR-tom-medium", "name": "Tom", "gender": "m"},
        {"id": "fr_FR-gilles-low", "name": "Gilles", "gender": "m"},
        {"id": "fr_FR-siwis-medium", "name": "Siwis", "gender": "f"},
    ],
    "it": [
        {"id": "it_IT-riccardo-x_low", "name": "Riccardo", "gender": "m"},
        {"id": "it_IT-paola-medium", "name": "Paola", "gender": "f"},
        {"id": "it_IT-serena-medium", "name": "Serena", "gender": "f"},
    ],
    "pt": [
        {"id": "pt_BR-faber-medium", "name": "Faber", "gender": "m", "accent": "BR"},
        {"id": "pt_BR-cadu-medium", "name": "Cadu", "gender": "m", "accent": "BR"},
        {"id": "pt_BR-jeff-medium", "name": "Jeff", "gender": "m", "accent": "BR"},
    ],
    "uk": [
        {"id": "uk_UA-ukrainian_tts-medium", "name": "Ukrainian TTS", "gender": "m"},
        {"id": "uk_UA-lada-x_low", "name": "Лада", "gender": "f"},
    ],
    "pl": [
        {"id": "pl_PL-darkman-medium", "name": "Darkman", "gender": "m"},
        {"id": "pl_PL-mc_speech-medium", "name": "MC Speech", "gender": "m"},
        {"id": "pl_PL-gosia-medium", "name": "Gosia", "gender": "f"},
    ],
    "nl": [
        {"id": "nl_NL-ronnie-medium", "name": "Ronnie", "gender": "m"},
        {"id": "nl_NL-pim-medium", "name": "Pim", "gender": "m"},
        {"id": "nl_BE-nathalie-medium", "name": "Nathalie", "gender": "f"},
    ],
}

# Default voice per language: the first in its list.
VOICES = {lang: entries[0]["id"] for lang, entries in VOICE_CATALOG.items()}

KNOWN_VOICE_IDS = {v["id"] for entries in VOICE_CATALOG.values() for v in entries}


def voice_repo_path(voice: str) -> str:
    """Where a voice lives inside rhasspy/piper-voices: lang/family/name/quality/."""
    family, speaker, quality = voice.split("-", 2)
    return f"{family.split('_')[0]}/{family}/{speaker}/{quality}/{voice}"

# Translation models, keyed "<source>-<target>". These are CTranslate2 int8
# conversions of Helsinki-NLP's OPUS-MT: about 78 MB and 20 ms per sentence,
# against 600 MB and 200 ms for the multilingual NLLB fallback.
MT_REPOS = {
    "en-ru": "manancode/opus-mt-en-ru-ctranslate2-android",
    "ru-en": "manancode/opus-mt-ru-en-ctranslate2-android",
    "en-de": "manancode/opus-mt-en-de-ctranslate2-android",
    "de-en": "manancode/opus-mt-de-en-ctranslate2-android",
    "en-es": "manancode/opus-mt-en-es-ctranslate2-android",
    "es-en": "manancode/opus-mt-es-en-ctranslate2-android",
    "en-fr": "manancode/opus-mt-en-fr-ctranslate2-android",
    "fr-en": "manancode/opus-mt-fr-en-ctranslate2-android",
    "en-it": "manancode/opus-mt-en-it-ctranslate2-android",
    "it-en": "manancode/opus-mt-it-en-ctranslate2-android",
}

# The multilingual alternative to the per-pair OPUS-MT models: one 600 MB
# model covering 200 languages, better with context and pronouns, about three
# times slower. Against Whisper's second of work that difference is noise, so
# the choice is really about quality versus disk.
#
# Licensed CC-BY-NC — fine for personal calls, not for selling a service.
NLLB_REPO = "JustFrederik/nllb-200-distilled-600M-ct2-int8"
NLLB_DIR = "nllb-200-distilled-600M"

# NLLB wants a script with every language; a bare "ru" means nothing to it.
NLLB_CODES = {
    "en": "eng_Latn", "ru": "rus_Cyrl", "de": "deu_Latn", "es": "spa_Latn",
    "fr": "fra_Latn", "it": "ita_Latn", "pt": "por_Latn", "nl": "nld_Latn",
    "pl": "pol_Latn", "uk": "ukr_Cyrl", "tr": "tur_Latn", "ar": "arb_Arab",
    "zh": "zho_Hans", "ja": "jpn_Jpan", "ko": "kor_Hang", "hi": "hin_Deva",
    "id": "ind_Latn", "vi": "vie_Latn", "cs": "ces_Latn", "sv": "swe_Latn",
}

PIPER_REPO = "rhasspy/piper-voices"


def _quiet_tokenizer_warning() -> None:
    """
    Silences one specific false alarm.

    transformers 5 pattern-matches NLLB's tokenizer.json against a known-bad
    Mistral regex and warns "this will lead to incorrect tokenization" on every
    single load. Encoding and decoding round-trip exactly here, and the warning
    lands on stderr, which is the engine's log — so it would bury the messages
    that do matter.
    """
    import warnings
    warnings.filterwarnings(
        "ignore", message=".*incorrect regex pattern.*", module="transformers.*")
    try:
        import transformers.utils.logging as tlog
        tlog.set_verbosity_error()
    except Exception:  # noqa: BLE001 - only cosmetic
        pass


def _register_cuda_dlls() -> None:
    """
    Makes pip-installed cuBLAS and cuDNN loadable.

    Since Python 3.8 Windows no longer searches PATH for the dependencies of
    extension modules, and pip drops these DLLs inside site-packages, where
    nothing looks for them. Without this, every CUDA start dies on
    "cublas64_12.dll is not found or cannot be loaded" even though the file is
    sitting right there.
    """
    if sys.platform != "win32":
        return
    base = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if not base.is_dir():
        return
    found = []
    for pkg in sorted(base.iterdir()):
        for sub in ("bin", "lib"):
            d = pkg / sub
            if d.is_dir():
                found.append(str(d))
                if hasattr(os, "add_dll_directory"):
                    try:
                        os.add_dll_directory(str(d))
                    except OSError:
                        pass
    # add_dll_directory alone is not enough. It only affects LoadLibraryEx calls
    # that opt into the new search order, and CTranslate2 asks for cuBLAS with a
    # plain LoadLibrary by name — which still searches PATH and nothing else.
    if found:
        os.environ["PATH"] = os.pathsep.join(found + [os.environ.get("PATH", "")])


_register_cuda_dlls()
_quiet_tokenizer_warning()


def log(*parts: Any) -> None:
    """Diagnostics go to stderr; stdout carries the handshake line only."""
    print("[local]", *parts, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Loaded models, shared between lanes and between sessions
# --------------------------------------------------------------------------
#
# Loading is what makes Start slow: eleven seconds of reading weights off disk
# per lane, and the two lanes were each loading their own copy of the same
# files. They do not need to.
#
# Whisper takes its language as an argument to transcribe(), not at
# construction, so one model serves both directions. NLLB is multilingual by
# design — same weights, different language token — so one translator serves
# both directions too. Only OPUS-MT is genuinely per-direction, and only the
# tokenizers differ per language.
#
# Keeping them here rather than on the Lane also means stopping a session no
# longer throws the models away. The second Start of an evening is instant.

_CACHE_LOCK = threading.Lock()
_CACHE: dict[tuple, Any] = {}
_WARMED: set[tuple] = set()


def cached(key: tuple, build: Callable[[], Any]) -> Any:
    """
    Builds once, then hands out the same object.

    The lock is held across the build on purpose. Two lanes starting together
    would otherwise both miss, both load NLLB, and briefly hold 1.2 GB of
    identical weights on a 4 GB card. Waiting is cheaper than that.
    """
    with _CACHE_LOCK:
        if key not in _CACHE:
            t0 = time.monotonic()
            _CACHE[key] = build()
            log(f"loaded {key[0]} {'/'.join(str(k) for k in key[1:])} "
                f"in {time.monotonic() - t0:.1f}s")
        return _CACHE[key]


# --------------------------------------------------------------------------
# Voice activity detection
# --------------------------------------------------------------------------


class Vad:
    """
    Energy gate with an adaptive noise floor.

    Silero would be more discriminating, but it costs a second ONNX session per
    lane and its streaming API has moved twice in a year. Both inputs here are
    forgiving — a near-field microphone and a digital cable feed, neither of
    them a noisy room over a phone speaker — and a floor that tracks the actual
    background beats a fixed threshold on both of them.
    """

    FRAME = 320  # 20 ms at 16 kHz

    def __init__(self, sensitivity: float = 0.5, endpoint_ms: int = 480,
                 max_utterance_ms: int = 9000, early_ms: int = 200):
        # sensitivity 0..1 maps to how far above the noise floor speech must sit
        self.ratio = 6.0 - 4.5 * max(0.0, min(1.0, sensitivity))
        self.floor_min = 0.0015 + 0.006 * (1.0 - max(0.0, min(1.0, sensitivity)))
        self.endpoint_frames = max(4, endpoint_ms // 20)
        # The point in the silence at which it becomes worth guessing that the
        # utterance is over. Always strictly before the endpoint, or there is
        # nothing to overlap with.
        self.early_frames = min(max(3, early_ms // 20), self.endpoint_frames - 1)
        self.max_frames = max(50, max_utterance_ms // 20)
        self.preroll_frames = 12  # 240 ms, so a soft first syllable survives

        self.noise = 0.01
        self.speaking = False
        self.silence_run = 0
        self.speech_run = 0
        self.voiced_frames = 0   # voiced frames so far in this utterance
        self.last_voiced_frames = 0  # same, surviving the reset in _take()
        self.frames: list[np.ndarray] = []
        self.pre: list[np.ndarray] = []

    def reset(self) -> None:
        self.speaking = False
        self.silence_run = 0
        self.speech_run = 0
        self.voiced_frames = 0
        self.frames.clear()
        self.pre.clear()

    def push(self, frame: np.ndarray) -> list[tuple[str, Optional[np.ndarray]]]:
        """Feeds one 20 ms frame and returns whatever events it produced."""
        events: list[tuple[str, Optional[np.ndarray]]] = []
        rms = float(np.sqrt(np.mean(frame.astype(np.float32) ** 2)) + 1e-9)
        threshold = max(self.noise * self.ratio, self.floor_min)
        voiced = rms > threshold

        # Learn the background only between utterances, and only downwards
        # in a hurry.
        #
        # Updating it on every quiet frame looks reasonable and is not: the gaps
        # between syllables are quiet but far louder than silence, so each one
        # drags the floor up, the threshold follows, and within a few sentences
        # the gate has gone deaf to the very voice that raised it. Measured on a
        # test recording the floor walked from 0.01 to 0.13 — louder than the
        # speech itself. Falling fast and rising slowly cannot do that, and
        # still tracks a room that genuinely gets noisier.
        if not voiced and not self.speaking:
            rate = 0.1 if rms < self.noise else 0.0008
            self.noise = (1 - rate) * self.noise + rate * rms

        if not self.speaking:
            self.pre.append(frame)
            if len(self.pre) > self.preroll_frames:
                self.pre.pop(0)
            self.speech_run = self.speech_run + 1 if voiced else 0
            if self.speech_run >= 3:
                self.speaking = True
                self.frames = list(self.pre)
                self.pre.clear()
                self.silence_run = 0
                events.append(("start", None))
            return events

        self.frames.append(frame)
        self.last_voiced_frames = self.voiced_frames + (1 if voiced else 0)
        if voiced:
            self.voiced_frames += 1
            self.silence_run = 0
        else:
            self.silence_run += 1

        if self.silence_run == self.early_frames:
            # Probably over; not certainly. Hand out a copy so the caller can
            # start work on it, and keep accumulating in case the speaker was
            # only drawing breath.
            events.append(("early", self.current()))

        if self.silence_run >= self.endpoint_frames:
            events.append(("end", self._take()))
        elif len(self.frames) >= self.max_frames:
            # A monologue with no real pause. Cut it anyway — waiting for a
            # breath that never comes is how a translator falls a minute behind.
            events.append(("end", self._take()))
        return events

    def _take(self) -> np.ndarray:
        audio = np.concatenate(self.frames) if self.frames else np.zeros(0, np.float32)
        self.reset()
        return audio

    def flush(self) -> Optional[np.ndarray]:
        if self.speaking and self.frames:
            return self._take()
        self.reset()
        return None

    def current(self) -> np.ndarray:
        if not self.frames:
            return np.zeros(0, np.float32)
        return np.concatenate(self.frames)


# --------------------------------------------------------------------------
# Model wrappers
# --------------------------------------------------------------------------


def make_asr(backend: str, size: str, language: str, threads: int, device: str):
    """One recogniser for one lane. `backend` is already resolved, not "auto"."""
    if backend == "whisper":
        return WhisperAsr(size, language, threads, device)
    if backend in ASR_MODELS:
        if language not in ASR_MODELS[backend]["languages"]:
            raise ValueError(
                f"{ASR_MODELS[backend]['label']} does not recognise {language}; "
                "pick Whisper or Auto")
        return OnnxAsr(backend, language, threads)
    raise ValueError(f"unknown recogniser {backend!r}")


class OnnxAsr:
    """
    GigaAM or Parakeet through onnx-asr, on the CPU.

    On the CPU deliberately. At 150-300 ms an utterance there is nothing to
    win on the GPU worth the cuDNN dependency, and it leaves the card to NLLB.
    int8 weights: a quarter of the size, measured indistinguishable in output.
    """

    def __init__(self, backend: str, language: str, threads: int):
        self.backend = backend
        self.language = language
        self.name = ASR_MODELS[backend]["model"]
        self.device = "cpu"
        self.model = cached(("asr", self.name, threads),
                            lambda: _build_onnx_asr(self.name, threads))

    def transcribe(self, audio: np.ndarray, quick: bool = False) -> str:
        # These decoders are greedy and fast either way; `quick` is Whisper's
        # concern and has nothing to trade off here.
        return str(self.model.recognize(audio.astype(np.float32), sample_rate=SAMPLE_RATE)).strip()


def _build_onnx_asr(name: str, threads: int):
    import onnx_asr
    import onnxruntime as ort

    path = ASR_DIR / name
    if not (path / "config.json").exists():
        raise FileNotFoundError(f"{name} is not downloaded ({path})")

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = max(1, threads)
    opts.inter_op_num_threads = 1
    return onnx_asr.load_model(name, path=str(path), quantization="int8",
                               sess_options=opts, providers=["CPUExecutionProvider"])


class SpeechGate:
    """
    Silero VAD as a yes/no on a finished utterance: is there speech in here?

    The energy gate that cuts the stream into utterances cannot tell a breath
    from a word, and neither can a transducer: hand Parakeet a breath and it
    says "Yeah." — in a call that becomes "Да." in the listener's ear, from
    nobody. Whisper had a no-speech detector; GigaAM and Parakeet do not. This
    is that detector, run once per candidate utterance, about 16 ms a time.
    """

    def __init__(self, min_speech_ms: int = 250):
        self.min_speech = min_speech_ms / 1000.0
        self.vad = cached(("silero-vad",), _build_silero)

    def speech_seconds(self, audio: np.ndarray) -> float:
        segments = next(self.vad.segment_batch(
            audio[None, :].astype(np.float32), np.array([audio.size]), SAMPLE_RATE))
        return sum(end - start for start, end in segments) / SAMPLE_RATE

    def has_speech(self, audio: np.ndarray) -> bool:
        try:
            return self.speech_seconds(audio) >= self.min_speech
        except Exception as err:  # noqa: BLE001 - a broken gate must fail open
            log(f"speech gate failed, letting audio through: {err}")
            return True


def _build_silero():
    import onnx_asr

    # 2 MB; fetched on first use if the download step never ran.
    return onnx_asr.load_vad("silero", path=str(ASR_DIR / "silero-vad"),
                             providers=["CPUExecutionProvider"])


class WhisperAsr:
    """
    Whisper via CTranslate2.

    The heavy part — the weights — is shared; only the language is per-lane.
    num_workers is 2 so the two directions can decode at the same time on the
    one model rather than queueing behind each other.
    """

    def __init__(self, size: str, language: str, threads: int, device: str = "cpu"):
        self.backend = "whisper"
        self.name = f"whisper-{size}"
        self.language = language
        self.size = size
        self.device = device
        self.model = cached(("whisper", size, device, threads),
                            lambda: _build_whisper(size, device, threads))

    def transcribe(self, audio: np.ndarray, quick: bool = False) -> str:
        segments, _info = self.model.transcribe(
            audio,
            language=self.language,
            task="transcribe",
            # Greedy for both. Beam search costs 40-60% more time for a
            # difference that is invisible on the one- and two-second
            # utterances a conversation is made of, and here time is the
            # entire product.
            beam_size=1,
            best_of=1,
            temperature=0.0,
            vad_filter=False,
            # Whisper hallucinates confidently on silence and repeats itself
            # across segments when it is allowed to see its own history. In a
            # live call that turns one bad guess into a stuck phrase.
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            compression_ratio_threshold=2.4,
        )
        return " ".join(s.text.strip() for s in segments).strip()


def _build_whisper(size: str, device: str, threads: int):
    from faster_whisper import WhisperModel

    return WhisperModel(
        size, device=device,
        compute_type="int8" if device == "cpu" else "int8_float16",
        cpu_threads=threads, num_workers=2,
        download_root=str(WHISPER_DIR),
    )


class Mt:
    """
    Text translation, on CTranslate2 either way.

    Two backends, because they fail in opposite directions:

    "opus"  Helsinki-NLP OPUS-MT, one 78 MB model per language pair. Fast
            (~60 ms a sentence) and blunt: it keeps the meaning and drops the
            trimmings, and it only exists for pairs somebody trained.
    "nllb"  NLLB-200 distilled 600M, one model for 200 languages. Slower
            (~200 ms) and better with pronouns, register and anything that
            needs the rest of the sentence to disambiguate.

    Both are sentence-level, so both get one sentence at a time.
    """

    # A sentence this short goes to OPUS-MT even when NLLB is the chosen
    # backend. NLLB was trained on long sentences and invents company for short
    # ones: measured, "Да." became "I'm going to.", "Хорошо." became "I'll be
    # right back." and "Yes." became "Нет, нет." OPUS-MT gets every one of
    # those right. Three words is where NLLB starts behaving.
    SHORT_WORDS = 3

    def __init__(self, source: str, target: str, threads: int,
                 backend: str = "opus", device: str = "cpu"):
        self.identity = source == target
        self.pair = f"{source}-{target}"
        self.backend = "identity" if self.identity else backend
        self.device = "cpu"
        self.short = None   # OPUS-MT for short sentences when NLLB is primary
        if self.identity:
            return
        if backend == "nllb":
            self._load_nllb(source, target, threads, device)
            try:
                self.short = Mt(source, target, threads, "opus")
            except FileNotFoundError:
                # Without it, short sentences go through NLLB and get cleaned
                # up as best we can. The download step fetches it, so this is
                # only the case for an install that predates the hybrid.
                log(f"OPUS-MT {self.pair} not present; NLLB will handle short sentences too")
        else:
            # OPUS-MT stays on the CPU whatever the setting says. It costs 60 ms
            # there, and the GPU's four gigabytes are better spent on Whisper.
            self._load_opus(threads)

    def _load_opus(self, threads: int) -> None:
        path = MT_DIR / f"opus-mt-{self.pair}"
        if not (path / "model.bin").exists():
            raise FileNotFoundError(
                f"translation model for {self.pair} is not downloaded ({path})")

        self.translator, self.sp_src, self.sp_tgt = cached(
            ("opus", self.pair, threads), lambda: _build_opus(path, threads))

    def _load_nllb(self, source: str, target: str, threads: int, device: str) -> None:
        path = MT_DIR / NLLB_DIR
        if not (path / "model.bin").exists():
            raise FileNotFoundError(f"NLLB is not downloaded ({path})")
        for lang in (source, target):
            if lang not in NLLB_CODES:
                raise ValueError(f"NLLB has no code configured for {lang}")

        self.src_code = NLLB_CODES[source]
        self.tgt_code = NLLB_CODES[target]

        want = device if device in ("cpu", "cuda") else "cpu"
        self.translator, self.device = cached(
            ("nllb", want, threads), lambda: _build_nllb(path, want, threads))
        # One tokenizer per source language — they are small, and the weights
        # they sit in front of are shared.
        self.tokenizer = cached(
            ("nllb-tok", self.src_code), lambda: _build_nllb_tokenizer(path, self.src_code))

    def translate(self, text: str) -> list[str]:
        """Returns one translated string per source sentence."""
        sentences = split_sentences(text)
        if self.identity or not sentences:
            return sentences
        if self.backend != "nllb":
            return self._translate_opus(sentences)

        # Route each sentence by length, translate each group as one batch,
        # and put the results back in order.
        is_short = [len(sentence.split()) <= self.SHORT_WORDS for sentence in sentences]
        out: list[Optional[str]] = [None] * len(sentences)
        if self.short is not None and any(is_short):
            shorts = [sent for sent, flag in zip(sentences, is_short) if flag]
            for idx, result in zip([i for i, f in enumerate(is_short) if f],
                                   self.short._translate_opus(shorts)):
                out[idx] = result
        rest = [i for i, done in enumerate(out) if done is None]
        if rest:
            for idx, result in zip(rest, self._translate_nllb([sentences[i] for i in rest])):
                out[idx] = tidy_nllb(result)
        return [r for r in out if r is not None]

    def _translate_opus(self, sentences: list[str]) -> list[str]:
        # OPUS-MT is sentence-level in the strictest sense: handed two sentences
        # at once it translates the first and then loops — "our project, our
        # project, our project" until the decoder hits its length cap.
        #
        # The `</s>` is not optional either: these conversions carry
        # add_source_eos=false, so without an explicit end token the decoder is
        # never told the input finished, and loops for that reason instead.
        tokens = [self.sp_src.encode(s, out_type=str) + ["</s>"] for s in sentences]
        results = self.translator.translate_batch(
            tokens, beam_size=2, max_decoding_length=256, replace_unknowns=True)
        return [self.sp_tgt.decode([t for t in r.hypotheses[0] if t != "</s>"])
                for r in results]

    def _translate_nllb(self, sentences: list[str]) -> list[str]:
        # NLLB picks its output language from a token forced as the first thing
        # the decoder emits — there is no other way to ask it for Russian.
        tokens = [self.tokenizer.convert_ids_to_tokens(self.tokenizer.encode(s))
                  for s in sentences]
        results = self.translator.translate_batch(
            tokens, target_prefix=[[self.tgt_code]] * len(tokens),
            beam_size=2, max_decoding_length=256, max_batch_size=8)
        out = []
        for r in results:
            # Drop the language token we forced; it is not part of the sentence.
            ids = self.tokenizer.convert_tokens_to_ids(r.hypotheses[0][1:])
            out.append(self.tokenizer.decode(ids, skip_special_tokens=True))
        return out


def _build_opus(path: Path, threads: int):
    import ctranslate2
    import sentencepiece

    return (
        ctranslate2.Translator(str(path), device="cpu", compute_type="int8",
                               inter_threads=2, intra_threads=threads),
        sentencepiece.SentencePieceProcessor(model_file=str(path / "source.spm")),
        sentencepiece.SentencePieceProcessor(model_file=str(path / "target.spm")),
    )


def _build_nllb(path: Path, device: str, threads: int):
    """
    Returns (translator, device_actually_used).

    int8_float16 on the GPU, not float16. Measured on a GTX 1630: int8 runs a
    sentence in 146 ms and plain float16 in 969 ms — seven times slower than
    the quantised path and four times slower than the CPU itself. Cards without
    tensor cores gain nothing from half precision, and this one evidently
    loses.
    """
    import ctranslate2

    compute = "int8" if device == "cpu" else "int8_float16"
    try:
        return (ctranslate2.Translator(str(path), device=device, compute_type=compute,
                                       inter_threads=2, intra_threads=threads), device)
    except Exception as err:  # noqa: BLE001
        if device == "cpu":
            raise
        # Refusing to start a call over a GPU that is merely full would be a
        # poor trade for 100 ms.
        log(f"NLLB could not load on the GPU ({err}); using the CPU")
        return (ctranslate2.Translator(str(path), device="cpu", compute_type="int8",
                                       inter_threads=2, intra_threads=threads), "cpu")


def _build_nllb_tokenizer(path: Path, src_code: str):
    # Pure sentencepiece under the hood, so transformers loads it with no torch
    # anywhere in sight.
    import transformers

    return transformers.AutoTokenizer.from_pretrained(str(path), src_lang=src_code)


class Tts:
    """Piper. Returns int16 PCM at the voice's own sample rate."""

    def __init__(self, voice: str):
        model = PIPER_DIR / f"{voice}.onnx"
        if not model.exists():
            raise FileNotFoundError(f"voice {voice} is not downloaded ({model})")
        self.voice = cached(("piper", voice), lambda: _build_piper(model))
        self.name = voice
        self.rate = 22050

    def speak(self, text: str) -> tuple[bytes, int]:
        chunks: list[bytes] = []
        rate = self.rate
        for chunk in self.voice.synthesize(text):
            chunks.append(chunk.audio_int16_bytes)
            rate = getattr(chunk, "sample_rate", rate)
        self.rate = rate
        return b"".join(chunks), rate


# --------------------------------------------------------------------------
# One lane
# --------------------------------------------------------------------------


def _build_piper(model: Path):
    from piper import PiperVoice

    return PiperVoice.load(str(model), config_path=str(model) + ".json")


@dataclass
class LaneConfig:
    name: str = "lane"
    source: str = "ru"
    target: str = "en"
    asr: str = "auto"            # auto | gigaam | parakeet | whisper
    whisper: str = "small"       # size, when asr resolves to whisper
    translator: str = "opus"     # opus | nllb
    voice: str = ""
    threads: int = 3
    device: str = "cpu"
    sensitivity: float = 0.5
    endpoint_ms: int = 480
    max_utterance_ms: int = 9000
    partials: bool = True
    min_speech_ms: int = 250     # Silero must find at least this much speech
    speculate: bool = True       # start recognising before the endpoint is certain
    early_ms: int = 200
    partial_interval_ms: int = 900
    min_chars: int = 2


SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+")

# Whisper's favourite things to say about silence. They arrive with high
# confidence and would otherwise be spoken aloud to the other person.
HALLUCINATIONS = {
    "", ".", "..", "...", "…", "you", "thank you", "thanks for watching",
    "thank you for watching", "subscribe", "bye", "продолжение следует",
    "субтитры сделал dimatorzok", "редактор субтитров а.синецкая",
    "спасибо за просмотр", "подписывайтесь на канал", "продолжение следует...",
}

# The ONNX recognisers are honest about hesitation: "э-э", "а-а", "и-и-и",
# "uh", "um" come through as written. Translated and spoken aloud they are
# noise ("And-and-and."), so a transcript that is *nothing but* hesitation is
# dropped. One real word alongside them and it goes through untouched.
FILLER = re.compile(r"^(?:[а-яёa-z](?:-[а-яёa-z])*|uh+|um+|hm+|mm+|ah+|eh+|э+|а+|м+|ну)$", re.I)


def only_fillers(text: str) -> bool:
    words = re.findall(r"[а-яёa-z][а-яёa-z-]*", text, re.I)
    return bool(words) and all(FILLER.match(w) for w in words)


class Lane:
    """
    Runs the whole pipeline for one direction on one worker thread.

    Audio arrives from the socket on the event loop, is gated by the VAD there
    (microseconds of work), and finished utterances are handed to the worker.
    Everything expensive — Whisper, OPUS-MT, Piper — happens on that worker, so
    a slow transcription never stalls the socket and never touches the other
    lane.
    """

    def __init__(self, cfg: LaneConfig, emit: Callable[[dict], None]):
        self.cfg = cfg
        self.emit = emit
        self.vad = Vad(cfg.sensitivity, cfg.endpoint_ms, cfg.max_utterance_ms, cfg.early_ms)
        self.thread: Optional[threading.Thread] = None

        # Two queues rather than one, because the two kinds of work are not
        # equally important. A final is what the other person actually hears;
        # a partial is a caption that will be replaced within the second. So
        # finals are a FIFO that never drops, partials are a single slot that
        # the newest one overwrites, and the worker always drains finals first.
        self._cv = threading.Condition()
        self._finals: list[tuple] = []
        self._partial: Optional[tuple] = None
        self.busy = False
        self.tail = np.zeros(0, np.float32)
        self.muted = False
        self.seq = 0
        self.last_partial = 0.0
        self.speech_started_at = 0.0
        self.last_utterance_s = 0.0

        # Speculation. When the silence after speech reaches `early_ms` the
        # audio so far is recognised and translated on the worker, and the
        # result is parked here keyed by (utterance, voiced frames). When the
        # endpoint arrives and nothing voiced has happened in between, the
        # final job finds its answer waiting and goes straight to speech. If
        # the speaker carried on, the key no longer matches and the guess is
        # quietly thrown away — one wasted recognition, nothing heard.
        self._spec: dict[tuple[int, int], tuple[str, list[str]]] = {}
        self._last_voiced = 0
        self.alive = True

        self.asr = None
        self.mt: Optional[Mt] = None
        self.tts: Optional[Tts] = None
        self.gate: Optional[SpeechGate] = None

    # ---------------------------------------------------------- lifecycle --

    def start(self) -> None:
        self.thread = threading.Thread(target=self._run, name=f"lane-{self.cfg.name}",
                                       daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.alive = False
        with self._cv:
            self._cv.notify_all()

    def _next_job(self) -> Optional[tuple]:
        with self._cv:
            while self.alive and not self._finals and self._partial is None:
                self._cv.wait()
            if not self.alive:
                return None
            if self._finals:
                return self._finals.pop(0)
            job, self._partial = self._partial, None
            return job

    # ------------------------------------------------------------- intake --

    def feed(self, pcm: bytes) -> None:
        """Called from the event loop with raw Int16 LE bytes."""
        if self.muted or not self.alive:
            return
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        if self.tail.size:
            samples = np.concatenate([self.tail, samples])

        usable = (samples.size // Vad.FRAME) * Vad.FRAME
        self.tail = samples[usable:].copy()

        for i in range(0, usable, Vad.FRAME):
            for kind, audio in self.vad.push(samples[i:i + Vad.FRAME]):
                self._last_voiced = self.vad.last_voiced_frames
                if kind == "start":
                    # The id is minted when speech begins, not when it ends, so
                    # the partials and the final that replaces them all carry
                    # the same id and the caption updates in place.
                    self.seq += 1
                    self.speech_started_at = time.monotonic()
                    self.last_partial = time.monotonic()
                elif kind == "early" and audio is not None and self.cfg.speculate:
                    # Submitted even if the worker is mid-partial: the guess
                    # then runs the moment the partial finishes, which is still
                    # well before the endpoint arrives.
                    if audio.size > SAMPLE_RATE * 0.5:
                        self._submit(audio, final=True,
                                     speculative=(self.seq, self.vad.voiced_frames))
                elif kind == "end" and audio is not None:
                    self._submit(audio, final=True)
                    self.last_utterance_s = audio.size / SAMPLE_RATE

        # Partials are pure decoration — a caption that moves while you speak.
        # They run the same expensive model as the finals, so they are allowed
        # only when the worker is genuinely idle. Left ungated they will happily
        # eat every spare cycle and push the translation seconds behind, which
        # is the opposite of what a caption is for.
        if self.cfg.partials and self.vad.speaking and not self.busy:
            now = time.monotonic()
            if (now - self.last_partial) * 1000 >= self.cfg.partial_interval_ms:
                current = self.vad.current()
                if current.size > SAMPLE_RATE * 0.6:
                    self.last_partial = now
                    self._submit(current.copy(), final=False)

    def flush(self) -> None:
        audio = self.vad.flush()
        if audio is not None and audio.size:
            self._submit(audio, final=True)

    def set_muted(self, muted: bool) -> None:
        self.muted = muted
        if muted:
            self.vad.reset()
            self.tail = np.zeros(0, np.float32)

    def _submit(self, audio: np.ndarray, final: bool,
                speculative: Optional[tuple[int, int]] = None) -> None:
        # The voiced-frame count is read *here*, on the intake thread, so a
        # final knows how much speech it covers and can be matched against a
        # guess made earlier about the same utterance.
        voiced = speculative[1] if speculative else self._last_voiced
        job = (self.seq, audio, final, time.monotonic(), speculative, voiced)
        with self._cv:
            if final:
                if speculative is not None:
                    # A newer guess supersedes any older one still queued: the
                    # speaker resumed, so the old audio is a prefix of nothing
                    # that will be asked for.
                    self._finals = [j for j in self._finals if j[4] is None]
                self._finals.append(job)
                # Whatever partial is waiting describes a prefix of this same
                # utterance. Transcribing it now would only delay the thing
                # that replaces it.
                self._partial = None
            else:
                self._partial = job
            self._cv.notify()

    # ------------------------------------------------------------- worker --

    def _run(self) -> None:
        try:
            self._load()
        except Exception as err:  # noqa: BLE001 - reported to the client
            log(f"{self.cfg.name}: load failed:", traceback.format_exc())
            self.emit({"type": "error", "fatal": True, "message": str(err)})
            return

        self.emit({"type": "ready", "info": {
            "lane": self.cfg.name,
            "asr": self.asr.name,
            "asrDevice": self.asr.device,
            "device": self.cfg.device,
            "mt": f"{self.mt.backend}:{self.mt.pair}",
            "mtDevice": self.mt.device,
            "voice": self.tts.name,
            "sampleRate": self.tts.rate,
        }})

        while self.alive:
            job = self._next_job()
            if job is None:
                break
            self.busy = True
            try:
                self._process(*job)
            except Exception as err:  # noqa: BLE001 - one bad utterance is survivable
                log(f"{self.cfg.name}: job failed:", traceback.format_exc())
                self.emit({"type": "error", "message": str(err)})
            finally:
                self.busy = False

    def _load(self) -> None:
        cfg = self.cfg
        t0 = time.monotonic()
        self.asr, self.mt, self.tts = build_stack(
            cfg, lambda stage: self.emit({"type": "loading", "stage": stage}))
        self.gate = SpeechGate(cfg.min_speech_ms)
        log(f"{cfg.name}: ready in {time.monotonic() - t0:.1f}s")

    def _process(self, seq: int, audio: np.ndarray, final: bool, started: float,
                 speculative: Optional[tuple[int, int]] = None, voiced: int = 0) -> None:
        # Anything that is about to be recognised has to contain speech. Checked
        # here rather than at intake so it runs on the worker and never stalls
        # the socket; and checked before the speculation cache is consulted so
        # a guess made on a breath is never promoted.
        hit_pending = final and speculative is None and (seq, voiced) in self._spec
        if not hit_pending and self.gate and not self.gate.has_speech(audio):
            if speculative is None and final:
                self._spec.clear()
            return

        if speculative is not None:
            # Guess: recognise and translate, park the result, say nothing.
            text = self.asr.transcribe(audio)
            if self._usable(text):
                self._spec[speculative] = (text, self.mt.translate(text))
            # Never keep more than the current guess around.
            for key in [k for k in self._spec if k[0] < seq]:
                del self._spec[key]
            return

        hit = self._spec.pop((seq, voiced), None) if final else None
        if hit is not None:
            text, sentences = hit
            self._spec.clear()
        else:
            text = self.asr.transcribe(audio, quick=not final)
            if not self._usable(text):
                return
            if not final:
                self.emit({"type": "partial", "id": seq, "source": text})
                return
            sentences = self.mt.translate(text)
        translated = " ".join(sentences).strip()
        self.emit({"type": "final", "id": seq, "source": text, "translated": translated})
        # Measured from the end of the phrase, not its beginning: what matters
        # is the silence the other person sits through after you stop talking,
        # and that does not grow with how long the sentence was.
        self.emit({"type": "lag", "ms": int((time.monotonic() - started) * 1000),
                   "utteranceMs": int(self.last_utterance_s * 1000),
                   "speculated": hit is not None})

        if not translated:
            return

        self.emit({"type": "speaking", "on": True})
        try:
            # Sentence at a time, so the first words reach the other person
            # while the rest is still being synthesised.
            for sentence in sentences:
                if not self.alive:
                    return
                pcm, rate = self.tts.speak(sentence)
                if pcm:
                    self.emit({
                        "type": "audio", "id": seq, "rate": rate,
                        "pcm": base64.b64encode(pcm).decode("ascii"),
                    })
        finally:
            self.emit({"type": "speaking", "on": False})

    def _usable(self, text: str) -> bool:
        stripped = text.strip()
        if len(stripped) < self.cfg.min_chars:
            return False
        if stripped.lower().strip(" .!?…") in HALLUCINATIONS:
            return False
        return not only_fillers(stripped)


# A sentence in each language we ship a voice for, used to exercise the
# pipeline before anybody is waiting on it.
WARM_TEXT = {
    "en": "This is a warm up sentence, so the first real one is not slow.",
    "ru": "Это разогревочная фраза, чтобы первая настоящая не была медленной.",
    "de": "Dies ist ein Aufwärmsatz.",
    "es": "Esta es una frase de calentamiento.",
    "fr": "Ceci est une phrase d échauffement.",
    "it": "Questa è una frase di riscaldamento.",
    "pt": "Esta é uma frase de aquecimento.",
}


def build_stack(cfg: "LaneConfig", notify: Optional[Callable[[str], None]] = None):
    """
    Loads and exercises everything one direction needs, and returns it.

    Shared by a starting lane and by the preload that runs while the user is
    still deciding, so both take exactly the same path and warm exactly the
    same things.
    """
    voice = cfg.voice or VOICES.get(cfg.target, "")
    if not voice:
        raise RuntimeError(f"no Piper voice configured for {cfg.target}")

    def step(stage: str) -> None:
        if notify:
            notify(stage)

    backend = pick_asr(cfg.asr, cfg.source)
    log(f"{cfg.name}: asr={backend}{'/' + cfg.whisper if backend == 'whisper' else ''} "
        f"mt={cfg.translator}:{cfg.source}-{cfg.target} voice={voice}")

    step("speech recognition")
    asr = make_asr(backend, cfg.whisper, cfg.source, cfg.threads, cfg.device)
    step("translation")
    mt = Mt(cfg.source, cfg.target, cfg.threads, cfg.translator, cfg.device)
    step("voice")
    tts = Tts(voice)

    # Exercise each stage once while nobody is waiting.
    #
    # It has to be exercised with something that looks like speech. The obvious
    # thing — a second of silence — is worse than useless: Whisper decides there
    # is no speech and returns before the decoder runs at all, so none of the
    # decoder's CUDA kernels get compiled and the first real sentence pays the
    # full three seconds anyway. Measured: silence 2.9 s, then noise a further
    # 3.0 s. Noise it is, and a real sentence through the translator, which was
    # costing 1.7 s on its first call against 0.2 s afterwards.
    # …but only once per combination. Warming is idempotent and costs about a
    # second and a half, which is most of what a warm Start now spends.
    warm_key = (asr.name, cfg.device, cfg.translator, cfg.source, cfg.target, voice)
    with _CACHE_LOCK:
        already = warm_key in _WARMED
        _WARMED.add(warm_key)
    if already:
        return asr, mt, tts

    step("warming up")
    SpeechGate().has_speech(np.zeros(SAMPLE_RATE, np.float32))
    noise = (np.random.default_rng(7).standard_normal(SAMPLE_RATE * 2) * 0.05)
    asr.transcribe(noise.astype(np.float32), quick=True)
    mt.translate(WARM_TEXT.get(cfg.source, WARM_TEXT["en"]))
    tts.speak(WARM_TEXT.get(cfg.target, WARM_TEXT["en"]))
    return asr, mt, tts


# NLLB learned from subtitles and it shows: it opens lines with a dialogue
# dash and likes to say things twice ("Хорошо. - Хорошо."). Neither belongs in
# speech.
_DASH = re.compile(r"^\s*[-–—]\s*")
_ECHO = re.compile(r"^(.+?[.!?])\s*[-–—]?\s*\1$")


def tidy_nllb(text: str) -> str:
    text = _DASH.sub("", text.strip())
    text = re.sub(r"\s+[-–—]\s+", " ", text)
    m = _ECHO.match(text)
    return m.group(1) if m else text


def split_sentences(text: str) -> list[str]:
    parts = [p.strip() for p in SENTENCE_SPLIT.split(text.strip()) if p.strip()]
    return parts or ([text.strip()] if text.strip() else [])


# --------------------------------------------------------------------------
# WebSocket server
# --------------------------------------------------------------------------


async def handle(websocket) -> None:
    loop = asyncio.get_running_loop()
    outbox: asyncio.Queue = asyncio.Queue()
    lane: Optional[Lane] = None

    def emit(message: dict) -> None:
        # Called from the worker thread.
        loop.call_soon_threadsafe(outbox.put_nowait, message)

    async def pump() -> None:
        while True:
            message = await outbox.get()
            if message is None:
                return
            await websocket.send(json.dumps(message))

    pumping = asyncio.create_task(pump())
    try:
        async for raw in websocket:
            if isinstance(raw, (bytes, bytearray)):
                if lane is not None:
                    lane.feed(bytes(raw))
                continue

            message = json.loads(raw)
            kind = message.get("type")

            if kind == "hello":
                if lane is not None:
                    lane.close()
                cfg = LaneConfig(**{k: v for k, v in message.items()
                                    if k in LaneConfig.__dataclass_fields__})
                lane = Lane(cfg, emit)
                lane.start()
            elif kind == "preload":
                # Load in the background and keep the socket answering; the
                # renderer sends this while the user is still in Setup.
                cfg = LaneConfig(**{k: v for k, v in message.items()
                                    if k in LaneConfig.__dataclass_fields__})
                threading.Thread(target=_preload, args=(cfg, emit),
                                 name="preload", daemon=True).start()
            elif kind == "say":
                # Voice preview for the Setup panel. Fetches the voice if
                # needed, speaks the text, returns the audio. Off the loop —
                # a first-time download can take a while.
                threading.Thread(
                    target=_say, args=(message, emit), name="say", daemon=True).start()
            elif kind == "mute" and lane:
                lane.set_muted(bool(message.get("on")))
            elif kind == "flush" and lane:
                lane.flush()
            elif kind == "ping":
                await websocket.send(json.dumps({"type": "pong"}))
    except Exception:  # noqa: BLE001 - a dropped socket is normal
        pass
    finally:
        if lane:
            lane.close()
        outbox.put_nowait(None)
        await asyncio.wait([pumping], timeout=1)


def _say(message: dict, emit: Callable[[dict], None]) -> None:
    voice = str(message.get("voice") or "")
    text = str(message.get("text") or "").strip()
    try:
        if voice not in KNOWN_VOICE_IDS:
            raise ValueError(f"unknown voice {voice}")
        fetch_voice(voice)
        pcm, rate = Tts(voice).speak(text or "Hello.")
        emit({"type": "said", "voice": voice, "rate": rate,
              "pcm": base64.b64encode(pcm).decode("ascii")})
    except Exception as err:  # noqa: BLE001 - reported to the client
        log(f"say failed: {err}")
        emit({"type": "say-failed", "voice": voice, "message": str(err)})


def _preload(cfg: LaneConfig, emit: Callable[[dict], None]) -> None:
    try:
        build_stack(cfg, lambda stage: emit({"type": "loading", "stage": stage}))
        emit({"type": "preloaded", "lane": cfg.name})
    except Exception as err:  # noqa: BLE001 - preloading is best effort
        log(f"preload failed: {err}")
        emit({"type": "preload-failed", "message": str(err)})


async def serve(port: int, host: str = "127.0.0.1") -> None:
    import websockets

    async with websockets.serve(handle, host, port, max_size=8 * 1024 * 1024,
                                ping_interval=20) as server:
        bound = server.sockets[0].getsockname()[1]
        # The one line on stdout: the supervisor reads it to learn the port.
        print(json.dumps({"type": "listening", "port": bound}), flush=True)
        log(f"listening on ws://{host}:{bound}")
        await asyncio.Future()


# --------------------------------------------------------------------------
# Model management
# --------------------------------------------------------------------------


def probe() -> dict:
    """Reports what is installed, for the Setup panel."""
    missing_pkgs = []
    for module in ("faster_whisper", "ctranslate2", "piper", "websockets",
                   "numpy", "sentencepiece"):
        try:
            __import__(module)
        except Exception:  # noqa: BLE001
            missing_pkgs.append(module)

    whisper = []
    if WHISPER_DIR.exists():
        for entry in WHISPER_DIR.iterdir():
            if not entry.is_dir() or not list(entry.rglob("model.bin")):
                continue
            # "models--Systran--faster-whisper-small" is the cache layout; the
            # rest of the app knows this model as "small".
            name = entry.name.split("--")[-1]
            for prefix in ("faster-whisper-", "faster-distil-whisper-"):
                if name.startswith(prefix):
                    name = name[len(prefix):]
            whisper.append(name)

    voices = sorted(p.stem for p in PIPER_DIR.glob("*.onnx")) if PIPER_DIR.exists() else []
    asr = sorted(key for key, info in ASR_MODELS.items()
                 if (ASR_DIR / info["model"] / "config.json").exists())
    pairs = sorted(p.name.replace("opus-mt-", "") for p in MT_DIR.glob("opus-mt-*")
                   if (p / "model.bin").exists()) if MT_DIR.exists() else []
    has_nllb = (MT_DIR / NLLB_DIR / "model.bin").exists()

    return {
        "python": sys.version.split()[0],
        "models": str(MODELS),
        "missingPackages": missing_pkgs,
        "whisper": sorted(set(whisper)),
        "voices": voices,
        "pairs": pairs,
        "nllb": has_nllb,
        "asr": asr,
        "vad": (ASR_DIR / "silero-vad" / "silero_vad.onnx").exists(),
        "asrLanguages": {key: info["languages"] for key, info in ASR_MODELS.items()},
        "whisperSizes": WHISPER_SIZES,
        "knownVoices": VOICES,
        "voiceCatalog": VOICE_CATALOG,
        "knownPairs": sorted(MT_REPOS),
        "nllbLanguages": sorted(NLLB_CODES),
    }


def fetch_voice(voice: str) -> Path:
    """Downloads one Piper voice (model + config) if it is not here yet."""
    from huggingface_hub import hf_hub_download

    if voice not in KNOWN_VOICE_IDS:
        raise ValueError(f"unknown voice {voice}")
    PIPER_DIR.mkdir(parents=True, exist_ok=True)
    model = PIPER_DIR / f"{voice}.onnx"
    if model.exists() and (PIPER_DIR / f"{voice}.onnx.json").exists():
        log(f"voice {voice} already present")
        return model
    base = voice_repo_path(voice)
    staging = PIPER_DIR / "_hf"
    for ext in (".onnx", ".onnx.json"):
        log(f"downloading {voice}{ext}")
        src = hf_hub_download(PIPER_REPO, base + ext, local_dir=str(staging))
        os.replace(src, PIPER_DIR / f"{voice}{ext}")
    # hf_hub_download mirrors the repo's folder tree under local_dir and leaves
    # it behind once the files are moved out. Empty, but untidy.
    shutil.rmtree(staging, ignore_errors=True)
    return model


def probe_gpu() -> dict:
    """
    Answers one question: can Whisper actually run on this GPU right now?

    Counting CUDA devices is not enough — the card can be present and the maths
    libraries missing — so this loads the smallest model and runs it. The result
    decides whether the Setup panel offers GPU at all.
    """
    try:
        import ctranslate2
    except Exception as err:  # noqa: BLE001
        return {"cuda": False, "reason": str(err)}

    count = ctranslate2.get_cuda_device_count()
    if not count:
        return {"cuda": False, "reason": "no CUDA device"}

    try:
        model = WhisperAsr("tiny", "en", 2, device="cuda")
        t0 = time.monotonic()
        model.transcribe(np.zeros(SAMPLE_RATE * 2, np.float32))
        return {"cuda": True, "devices": count,
                "warmupMs": int((time.monotonic() - t0) * 1000)}
    except Exception as err:  # noqa: BLE001
        return {"cuda": False, "devices": count, "reason": str(err)}


def download(whisper: str = "small", langs: Iterable[str] = ("en", "ru"),
             translator: str = "opus", asr: str = "auto",
             voices: Iterable[str] = ()) -> None:
    from huggingface_hub import hf_hub_download, snapshot_download

    langs = list(dict.fromkeys(langs))

    # Recognisers first: they decide whether Whisper is needed at all.
    needed = {pick_asr(asr, lang) for lang in langs}
    for backend in sorted(needed - {"whisper"}):
        name = ASR_MODELS[backend]["model"]
        target = ASR_DIR / name
        if (target / "config.json").exists():
            log(f"{name} already present")
            continue
        log(f"downloading {name} (int8)")
        import onnx_asr
        # load_model with a path that does not exist yet downloads exactly the
        # files this quantisation needs into it — no hub cache, no duplicates.
        onnx_asr.load_model(name, path=str(target), quantization="int8",
                            providers=["CPUExecutionProvider"])
    if not (ASR_DIR / "silero-vad" / "silero_vad.onnx").exists():
        log("downloading silero-vad")
        _build_silero()

    PIPER_DIR.mkdir(parents=True, exist_ok=True)
    MT_DIR.mkdir(parents=True, exist_ok=True)

    # The voices the user picked, plus each language's default as a fallback.
    wanted = [v for v in voices if v] + [VOICES[l] for l in langs if l in VOICES]
    for lang in langs:
        if lang not in VOICES:
            log(f"no voice known for {lang}, skipping")
    for voice in dict.fromkeys(wanted):
        fetch_voice(voice)

    # OPUS-MT pairs are fetched for both backends: on their own when chosen,
    # and as the short-sentence translator under NLLB. 78 MB a direction.
    for a in langs:
        for b in langs:
            repo = MT_REPOS.get(f"{a}-{b}")
            if a == b or not repo:
                continue
            target = MT_DIR / f"opus-mt-{a}-{b}"
            if (target / "model.bin").exists():
                log(f"translation {a}-{b} already present")
                continue
            log(f"downloading translation {a}-{b}")
            snapshot_download(repo, local_dir=str(target))

    if translator == "nllb":
        target = MT_DIR / NLLB_DIR
        if (target / "model.bin").exists():
            log("NLLB already present")
        else:
            log("downloading NLLB (620 MB)")
            snapshot_download(NLLB_REPO, local_dir=str(target))

    if "whisper" in needed:
        log(f"downloading whisper {whisper}")
        from faster_whisper import WhisperModel

        WhisperModel(whisper, device="cpu", compute_type="int8",
                     download_root=str(WHISPER_DIR))
    log("done")


def selftest(source: str, target: str, whisper: str) -> None:
    """
    Full round trip on synthetic audio.

    Speech for the test is synthesised with the *source* language's own Piper
    voice, resampled to 16 kHz, and pushed through the lane exactly as the
    renderer would push microphone frames — VAD included. If this passes, every
    stage works and the only thing left untested is the audio routing in
    Windows.
    """
    results: list[dict] = []
    lock = threading.Lock()

    def collect(message: dict) -> None:
        with lock:
            results.append(message)

    log("loading…")
    cfg = LaneConfig(name="selftest", source=source, target=target, whisper=whisper,
                     translator=os.environ.get("VOICEB_MT", "opus"))
    lane = Lane(cfg, collect)
    lane.start()

    def first(kind):
        with lock:
            return next((r for r in results if r.get("type") == kind), None)

    for _ in range(1800):
        if first("ready") or first("error") or not lane.thread.is_alive():
            break
        time.sleep(0.1)
    if first("error"):
        raise SystemExit(f"load failed: {first('error')['message']}")
    if not first("ready"):
        raise SystemExit("engine never became ready")
    log("ready:", json.dumps(first("ready")["info"], ensure_ascii=False))

    phrase = {
        "ru": "Привет, как дела? Я хочу обсудить наш проект и сроки сдачи.",
        "en": "Hello, how are you? I would like to discuss our project and the deadlines.",
    }.get(source, "Hello there, this is a test.")

    log(f"speaking test phrase as {source}: {phrase!r}")
    speaker = Tts(VOICES[source])
    pcm, rate = speaker.speak(phrase)
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
    # Nearest-neighbour is plenty: this is a plumbing test, not a fidelity one.
    idx = (np.arange(int(len(audio) * SAMPLE_RATE / rate)) * rate / SAMPLE_RATE)
    audio = audio[np.clip(idx.astype(int), 0, len(audio) - 1)]

    started = time.monotonic()
    lane.feed(audio.astype("<i2").tobytes())
    lane.feed(np.zeros(SAMPLE_RATE, "<i2").tobytes())  # trailing silence ends it

    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        with lock:
            if any(r.get("type") == "audio" for r in results):
                break
        time.sleep(0.1)

    finals = [r for r in results if r.get("type") == "final"]
    audios = [r for r in results if r.get("type") == "audio"]
    for r in finals:
        log(f"heard   : {r['source']!r}")
        log(f"produced: {r['translated']!r}")
    if not finals:
        raise SystemExit("no transcript came back — check the VAD and Whisper")
    if not audios:
        raise SystemExit("transcript arrived but no audio was synthesised")

    samples = sum(len(base64.b64decode(a["pcm"])) // 2 for a in audios)
    log(f"synthesised {samples / audios[0]['rate']:.1f}s of speech "
        f"in {time.monotonic() - started:.1f}s wall clock")
    lane.close()
    log("selftest OK")


# --------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="VoiceB local translation engine")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--probe-gpu", dest="probe_gpu", action="store_true")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--whisper", default="small")
    parser.add_argument("--langs", default="en,ru")
    parser.add_argument("--translator", default="opus", choices=["opus", "nllb"])
    parser.add_argument("--asr", default="auto",
                        choices=["auto", "gigaam", "parakeet", "whisper"])
    parser.add_argument("--voices", default="", help="comma-separated Piper voice ids")
    parser.add_argument("--source", default="ru")
    parser.add_argument("--target", default="en")
    args = parser.parse_args()

    if args.probe:
        print(json.dumps(probe(), ensure_ascii=False))
        return
    if args.probe_gpu:
        print(json.dumps(probe_gpu(), ensure_ascii=False))
        return
    if args.download:
        download(args.whisper, [s.strip() for s in args.langs.split(",") if s.strip()],
                 args.translator, args.asr,
                 [v.strip() for v in args.voices.split(",") if v.strip()])
        return
    if args.selftest:
        selftest(args.source, args.target, args.whisper)
        return

    asyncio.run(serve(args.port, args.host))


if __name__ == "__main__":
    main()
