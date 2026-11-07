$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$demoDirectory = Join-Path $taskRoot 'public/demo'
$scratchDirectory = Join-Path $taskRoot 'data/demo-build'
New-Item -ItemType Directory -Force -Path $demoDirectory,$scratchDirectory | Out-Null
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0
$sentences = @(
  @{voice='Microsoft David Desktop';speaker='s1';text='Welcome back to Audio Notes. Today we are talking about building a creative habit that actually lasts.'},
  @{voice='Microsoft Zira Desktop';speaker='s2';text='For me, the first step is to start small. Choose something you can repeat even on a busy day.'},
  @{voice='Microsoft David Desktop';speaker='s1';text='I like that. Before recording this podcast, I spend fifteen minutes writing down three ideas. No editing, just ideas.'},
  @{voice='Microsoft Zira Desktop';speaker='s2';text='Think of it as an appointment with yourself. You only need to show up. You do not have to wait for inspiration.'},
  @{voice='Microsoft David Desktop';speaker='s1';text='What about the days when your energy is low? How do you keep going without burning out?'},
  @{voice='Microsoft Zira Desktop';speaker='s2';text='Lower the difficulty. An imperfect draft is better than a blank page. A good system should make you want to come back tomorrow.'},
  @{voice='Microsoft David Desktop';speaker='s1';text='That is our takeaway for today. Pick one small creative habit for this week, and give yourself room to begin again.'},
  @{voice='Microsoft Zira Desktop';speaker='s2';text='Thank you for listening. Save the idea that speaks to you, and we will see you in the next episode.'}
)
$segments = @()
for($index=0; $index -lt $sentences.Count; $index++) {
  $target = Join-Path $scratchDirectory "line-$index.wav"
  $synth.SelectVoice($sentences[$index].voice)
  $synth.SetOutputToWaveFile($target)
  $synth.Speak($sentences[$index].text)
  $synth.SetOutputToNull()
  $segments += @{file=$target;speaker=$sentences[$index].speaker;text=$sentences[$index].text}
}
$synth.Dispose()
$segments | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $scratchDirectory 'segments.json') -Encoding UTF8
Set-Location -LiteralPath $taskRoot
node scripts/finish-demo.mjs
if($LASTEXITCODE -ne 0) { throw 'Demo generation failed.' }
