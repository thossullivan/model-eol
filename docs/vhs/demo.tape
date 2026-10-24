# model-eol demo for the README
# Run from the repo root: vhs docs/vhs/demo.tape
# Output depends on today's date, so re-record when the README sample changes.

Output docs/img/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1700
Set Height 320
Set Theme "Catppuccin Mocha"
Set Padding 24
Set TypingSpeed 40ms
Set WindowBar Colorful
Set WindowBarSize 40

Hide
Type `export PS1='$ '; alias model-eol="node $PWD/check.mjs"; cd test/fixture; clear`
Enter
Show

Type "# check one file against the publishers' dates"
Enter
Type "model-eol app.py --days 90"
Enter
Sleep 4.5s

Type "clear"
Enter
Type "# the same file, using Amazon Bedrock's dates"
Enter
Type "model-eol app.py --days 90 --via aws-bedrock"
Enter
Sleep 4.5s

Type "clear"
Enter
Type "# the earliest retirement in the file"
Enter
Type "model-eol schedule app.py --days 90 | tail -1"
Enter
Sleep 3.5s
