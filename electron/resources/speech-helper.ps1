# Native Windows speech-to-text helper (Windows 10/11, on-device).
# Mirrors the macOS speech-helper.swift NDJSON protocol on stdout:
#   {"partial":true,"text":"…"}   while recognizing
#   {"partial":false,"text":"…"}  final result, then exit 0
#   {"error":"…"}                 then exit 1
# Runs until the final result or killed. Spawned by electron/speech.mjs
# from the MAIN process so the mic permission prompt attributes to the app.
$ErrorActionPreference = "Stop"

function Emit([hashtable]$obj) {
  $json = $obj | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Speech
  $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $recognizer.SetInputToDefaultAudioDevice()

  # English-US dictation. If the grammar is missing on this system, report
  # a friendly error and exit 1 (the UI shows it in the composer).
  try {
    $grammar = New-Object System.Speech.Recognition.DictationGrammar
    $recognizer.LoadGrammar($grammar)
  } catch {
    Emit @{ error = "dictation-grammar-unavailable" }
    exit 1
  }

  $hypothesized = {
    param($s, $e)
    Emit @{ partial = $true; text = $e.Result.Text }
  }
  $recognized = {
    param($s, $e)
    Emit @{ partial = $false; text = $e.Result.Text }
    exit 0
  }

  $recognizer.add_SpeechHypothesized($hypothesized)
  $recognizer.add_SpeechRecognized($recognized)

  $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

  # Keep the process alive; kill() from speech.mjs terminates us.
  while ($true) { Start-Sleep -Milliseconds 200 }
} catch {
  Emit @{ error = "speech-unavailable" }
  exit 1
}
