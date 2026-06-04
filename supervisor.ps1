#requires -version 5.1
# signal-rc-bot 常駐ラッパ（SPEC v2.0 §5.3）。
# bot を while ループで監視し、clean exit / クラッシュいずれでも5秒後に再起動する。
# Task Scheduler には「このスクリプト」をログオン時トリガ(30-60秒遅延)で登録する:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <このファイル>
# 注意: Start-Process に -RedirectStandard*/-NoNewWindow は付けない(ExitCode破損 PS#5421)。
#       ログは bot.mjs 自身が出力する。

$ErrorActionPreference = "Continue"
Set-Location -Path $PSScriptRoot

while ($true) {
  try {
    $p = Start-Process -FilePath "node.exe" -ArgumentList "src\index.mjs" `
         -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden
    $p.WaitForExit()
  } catch {
    # node 起動自体に失敗しても落とさず再試行
  }
  Start-Sleep -Seconds 5
}
