# VHS tape: model-eol 30-second demo
# Run from repo root: vhs docs/vhs/demo.tape

Output docs/img/demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 950
Set Height 520
Set Theme "Catppuccin Mocha"
Set Padding 20
Set TypingSpeed 40ms
Set WindowBar Colorful
Set WindowBarSize 40

Type "# which of my models are already dead?"
Enter
Type "node check.mjs test/fixture --days 90"
Enter
Sleep 4.5s

Type "clear"
Enter
Type "# same repo, judged by Amazon Bedrock's clock instead"
Enter
Type "node check.mjs test/fixture --days 90 --via aws-bedrock"
Enter
Sleep 4.5s

Type "clear"
Enter
Type "# worst case date for the whole repo"
Enter
Type "node check.mjs schedule test/fixture --days 90 | tail -2"
Enter
Sleep 4s
