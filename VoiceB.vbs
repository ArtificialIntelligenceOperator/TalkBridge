' VoiceB launcher.
'
' Two things a plain shortcut to electron.exe cannot do:
'   1. Clear ELECTRON_RUN_AS_NODE. Editors and agent tooling export it, and
'      inherited into our launch it makes electron.exe behave like plain Node —
'      no window, just an immediate exit.
'   2. Start without a console window flashing up, the way a .cmd would.
'
' Paths are derived from this file's location, so the folder can be moved.

Option Explicit

Dim fso, sh, root, electron
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
electron = fso.BuildPath(root, "node_modules\electron\dist\electron.exe")

If Not fso.FileExists(electron) Then
    MsgBox "Electron is not installed." & vbCrLf & vbCrLf & _
           "Open a terminal in" & vbCrLf & root & vbCrLf & "and run:  npm install", _
           vbExclamation, "VoiceB"
    WScript.Quit 1
End If

On Error Resume Next
sh.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0

sh.CurrentDirectory = root
' 1 = normal window, False = do not wait for it to exit
sh.Run """" & electron & """ """ & root & """", 1, False
