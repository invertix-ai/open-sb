// The agent capability tasks. Each has a prompt for the agent and a verify command the harness runs in the
// sandbox afterwards: exit code 0 means the task passed. Verify commands recompute or re-measure what they
// check (they never take the agent's word, or a file the agent could have edited, as the expected value) and
// use only POSIX shell, awk, od and the tool under test, so they also run on images without Python. Some
// tasks need inputs the agent must not make itself: the harness writes their `files` and runs their `setup`
// before the agent starts. Prompts assume a Debian-like image that may lack tools, and say how to install them.

export interface SetupStep {
  /** What the terminal shows while it runs. */
  label: string;
  command: string;
  cwd?: string;
  /** Keep it running after the call returns (a server); started with startBackground or nohup. */
  background?: boolean;
}

export interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  verify: string;
  /** A port the task serves on: the UI previews it live when the provider has `ports`. */
  port?: number;
  /** Written by the harness before the agent starts. */
  files?: { path: string; content: string }[];
  /** Run by the harness, in order, after `files` and before the agent starts. A failing step fails the task. */
  setup?: SetupStep[];
  /** Installs large toolchains (a browser, ffmpeg): slow and not selected by default. */
  heavy?: boolean;
}

export const SYSTEM_PROMPT = `You are an engineer working inside a fresh Linux sandbox (Debian-like) through two tools:
run_command runs a shell command and returns its exit code and output; write_file writes a whole file.
- Use absolute paths. Each run_command starts a new shell, so \`cd\` and exported variables do not carry over; use the cwd parameter or chain commands with &&.
- Tools may be missing. Install them with \`apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y <packages>\` (prefix with sudo if you are not root), or with pip.
- A command must return: start long-running processes in the background with nohup or setsid, redirect their output to a file, and do not wait on them.
- Work until the task is done and you have checked it yourself, then reply with a one-paragraph summary and stop calling tools.`;

/** Installs python3 when it is missing (as root, or with sudo). */
const ENSURE_PYTHON = `command -v python3 >/dev/null 2>&1 || { S=; [ "$(id -u)" = 0 ] || S=sudo; $S apt-get update -qq && DEBIAN_FRONTEND=noninteractive $S apt-get install -y -qq python3 >/dev/null; }; command -v python3`;

export const SALES_ROWS = 200_000;
export const SALES_REGIONS = ["north", "south", "east", "west", "central"];
const SALES_PRODUCTS = ["apple", "banana", "cherry", "date", "elder", "fig", "grape", "honeydew"];

/**
 * The sales data, from a Park-Miller generator with a fixed seed: every product stays below 2^53, so any awk
 * (mawk, gawk, BusyBox, BWK) computes the same rows. `csv` prints the file; `sum` prints "region total" lines,
 * recomputed from the generator rather than from the file the agent can touch.
 */
export function salesAwk(mode: "csv" | "sum"): string {
  return `awk 'BEGIN {
  s = 20261120; split("${SALES_REGIONS.join(" ")}", R, " "); split("${SALES_PRODUCTS.join(" ")}", P, " ")
  ${mode === "csv" ? 'print "id,region,product,units,price_cents"' : ""}
  for (i = 1; i <= ${SALES_ROWS}; i++) {
    s = (s * 16807) % 2147483647; r = 1 + s % 5
    s = (s * 16807) % 2147483647; p = 1 + s % 8
    s = (s * 16807) % 2147483647; u = 1 + s % 20
    s = (s * 16807) % 2147483647; c = 100 + s % 9900
    ${mode === "csv" ? 'printf "%d,%s,%s,%d,%d\\n", i, R[r], P[p], u, c' : "rev[R[r]] += u * c"}
  }
  ${mode === "sum" ? 'for (k in rev) printf "%s %.0f\\n", k, rev[k]' : ""}
}'`;
}

/** What the browser page's script renders into #secret; only running its JavaScript produces it. */
export const BROWSER_VALUE = `osb-${[..."xq7v"].map(c => c.charCodeAt(0) * 3).join("-")}`;
const BROWSER_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>open-sb browser check</title></head>
<body style="font-family: sans-serif; padding: 2rem">
<h1>open-sb browser check</h1><p id="status">rendering...</p><span id="secret" hidden></span>
<script>
setTimeout(function () {
  var v = "osb-" + "xq7v".split("").map(function (c) { return c.charCodeAt(0) * 3; }).join("-");
  document.getElementById("secret").textContent = v;
  document.getElementById("status").textContent = "rendered";
}, 400);
</script>
</body></html>
`;

/** Shell helpers for verify commands: PNG magic bytes, and big-endian 32-bit numbers at an offset. */
const PNG_CHECK = `is_png() { [ "$(head -c 8 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \\n')" = 89504e470d0a1a0a ]; }
u32() { od -An -tu1 -j "$2" -N 4 "$1" | tr '\n' ' ' | awk '{ print $1 * 16777216 + $2 * 65536 + $3 * 256 + $4 }'; }
bytes() { wc -c < "$1" | tr -d ' '; }`;

export const TASKS: AgentTask[] = [
  {
    id: "fizzbuzz",
    title: "Python FizzBuzz with tests",
    prompt: `In /tmp/fizzbuzz, write fizzbuzz.py with a function fizzbuzz(n: int) -> str that returns "Fizz" for multiples of 3, "Buzz" for multiples of 5, "FizzBuzz" for multiples of both, and str(n) otherwise. Also write test_fizzbuzz.py with unittest test cases covering all four cases. Make sure \`python3 -m unittest discover -s /tmp/fizzbuzz\` passes (install python3 if it is missing).`,
    verify: `set -e
cd /tmp/fizzbuzz
test -f fizzbuzz.py
ls test_*.py >/dev/null
python3 -m unittest discover -s /tmp/fizzbuzz -p 'test_*.py'
python3 -c "from fizzbuzz import fizzbuzz as f; assert [f(3), f(5), f(15), f(7)] == ['Fizz', 'Buzz', 'FizzBuzz', '7']"`,
  },
  {
    id: "http",
    title: "HTTP server on port 8080",
    port: 8080,
    prompt: `Build a tiny HTTP server (Node or Python, your choice; install what you need) that answers every GET request on port 8080 with the JSON body {"ok":true} and a JSON content type. Run it in the background so it keeps running after your command returns, then prove it works with curl (install curl if needed).`,
    verify: `body=$(curl -fsS --max-time 5 http://127.0.0.1:8080/) || exit 1
echo "$body"
printf %s "$body" | tr -d ' \\n\\r\\t' | grep -q '"ok":true'`,
  },
  {
    id: "git",
    title: "Git repo, commit and branch",
    prompt: `Create a git repository in /tmp/repo (install git if needed). Add a file README.md with any content, commit it (set a local user.name and user.email if git asks), and create a branch named feature.`,
    verify: `set -e
cd /tmp/repo
git rev-parse --verify HEAD >/dev/null
git rev-parse --verify refs/heads/feature >/dev/null
test -n "$(git ls-files)"
git log --oneline | head -n 3`,
  },
  {
    id: "largest",
    title: "Largest file under /usr/share",
    prompt: `Find the largest regular file under /usr/share (by size in bytes, not following symlinks) and write its absolute path, alone on the first line, to /tmp/answer.txt. Do not install or remove any packages for this task: that would change /usr/share.`,
    // Any file of the largest size counts, so ties pass.
    verify: `answer=$(head -n 1 /tmp/answer.txt | tr -d '\\r')
case "$answer" in /usr/share/*) ;; *) echo "answer is not under /usr/share: $answer"; exit 1 ;; esac
test -f "$answer" && test ! -L "$answer" || { echo "not a regular file: $answer"; exit 1; }
max=$(find /usr/share -type f -printf '%s\\n' 2>/dev/null | sort -n | tail -n 1)
size=$(stat -c %s "$answer")
echo "answer $answer is $size bytes; largest is $max bytes"
test "$size" = "$max"`,
  },
  {
    id: "data",
    title: "Data analysis on a 200k-row CSV",
    prompt: `The file /tmp/data/sales.csv (${SALES_ROWS.toLocaleString("en")} rows, with a header) has the columns id,region,product,units,price_cents. For each region, compute the total revenue in cents: the sum of units * price_cents over that region's rows. Write /tmp/answer.json as one JSON object that maps every region name to its total as an integer, for example {"north": 123, "south": 456}. Use any tool you like (install it if it is missing), and check your numbers.`,
    setup: [{ label: `generate /tmp/data/sales.csv (${SALES_ROWS.toLocaleString("en")} rows, fixed seed)`, command: `mkdir -p /tmp/data && ${salesAwk("csv")} > /tmp/data/sales.csv && wc -l < /tmp/data/sales.csv` }],
    // The expected totals come from the generator, not from the CSV the agent could have changed.
    verify: `test -s /tmp/answer.json || { echo "no /tmp/answer.json"; exit 1; }
answer=$(tr -d ' \\n\\r\\t' < /tmp/answer.json)
${salesAwk("sum")} > /tmp/.osb-expected || exit 1
fail=0
while read region total; do
  case "$answer" in
    *"\\"$region\\":$total,"*|*"\\"$region\\":$total}"*|*"\\"$region\\":$total.0,"*|*"\\"$region\\":$total.0}"*) echo "$region: $total ok" ;;
    *) echo "$region: wrong or missing (expected $total)"; fail=1 ;;
  esac
done < /tmp/.osb-expected
keys=$(printf %s "$answer" | grep -o '"[a-z]*":' | wc -l | tr -d ' ')
[ "$keys" = ${SALES_REGIONS.length} ] || { echo "expected ${SALES_REGIONS.length} regions, found $keys keys"; fail=1; }
exit $fail`,
  },
  {
    id: "browser",
    title: "Headless browser on a local page",
    heavy: true,
    prompt: `A web page is served inside this sandbox at http://127.0.0.1:8090/ (do not use any external website). Shortly after it loads, its JavaScript fills a hidden element with id "secret". Using a real headless browser (for example Playwright with Chromium, installed with pip or npm, or Chromium in headless mode), load the page, wait until #secret has text, and write that text alone to /tmp/answer.txt. Also save a PNG screenshot of the page to /tmp/shot.png.`,
    files: [{ path: "/tmp/osb-site/index.html", content: BROWSER_PAGE }],
    setup: [
      { label: "make sure python3 is there to serve the page", command: ENSURE_PYTHON },
      { label: "serve the page on 127.0.0.1:8090", command: "python3 -m http.server 8090 --bind 127.0.0.1", cwd: "/tmp/osb-site", background: true },
      { label: "wait for the page to answer", command: `for i in $(seq 1 40); do python3 -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8090/', timeout=2)" 2>/dev/null && echo up && exit 0; sleep 0.25; done; echo "the page server did not start"; exit 1` },
    ],
    verify: `${PNG_CHECK}
got=$(head -n 1 /tmp/answer.txt 2>/dev/null | tr -d '\\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
[ "$got" = "${BROWSER_VALUE}" ] || { echo "answer.txt has '$got', not the value the page's JavaScript renders"; exit 1; }
is_png /tmp/shot.png || { echo "/tmp/shot.png is missing or not a PNG"; exit 1; }
size=$(bytes /tmp/shot.png)
[ "$size" -gt 2000 ] || { echo "/tmp/shot.png is only $size bytes"; exit 1; }
echo "rendered value ok; screenshot $(u32 /tmp/shot.png 16)x$(u32 /tmp/shot.png 20), $size bytes"`,
  },
  {
    id: "report",
    title: "PDF report and PNG chart",
    prompt: `Quarterly sales, in thousand units: Q1 120, Q2 95, Q3 143, Q4 171. 1) Draw a bar chart of them and save it as a PNG of at least 400x300 pixels to /tmp/report/chart.png. 2) Write a one-page PDF report to /tmp/report/report.pdf that contains the chart and the text line "Total: 529", and set the PDF's document title metadata to OSB-REPORT-7341. Use any tools (for example Python with matplotlib and reportlab; install what you need).`,
    verify: `${PNG_CHECK}
pdf=/tmp/report/report.pdf png=/tmp/report/chart.png
[ "$(head -c 5 $pdf 2>/dev/null)" = "%PDF-" ] || { echo "$pdf is missing or not a PDF"; exit 1; }
[ "$(bytes $pdf)" -gt 1000 ] || { echo "$pdf is only $(bytes $pdf) bytes"; exit 1; }
if command -v pdftotext >/dev/null 2>&1; then
  pdftotext $pdf - | tr -s ' \\t' ' ' | grep -q "Total: 529" || { echo "the PDF text has no 'Total: 529' (pdftotext)"; exit 1; }
  echo "PDF text ok (pdftotext)"
else
  grep -aq "OSB-REPORT-7341" $pdf || { echo "no OSB-REPORT-7341 title in the PDF (and no pdftotext to read its text)"; exit 1; }
  echo "PDF title marker ok (no pdftotext)"
fi
is_png $png || { echo "$png is missing or not a PNG"; exit 1; }
w=$(u32 $png 16) h=$(u32 $png 20)
[ "$w" -ge 400 ] && [ "$h" -ge 300 ] || { echo "chart is \${w}x\${h}, smaller than 400x300"; exit 1; }
[ "$(bytes $png)" -gt 2000 ] || { echo "chart is only $(bytes $png) bytes"; exit 1; }
echo "chart \${w}x\${h} ok"`,
  },
  {
    id: "ffmpeg",
    title: "Video with ffmpeg",
    heavy: true,
    prompt: `Install ffmpeg. Generate a 2-second, 320x240 test video at /tmp/media/test.mp4 with the H.264 codec from ffmpeg's testsrc pattern, then convert it to /tmp/media/test.webm with a VP9 (or VP8) video codec.`,
    // ffprobe reads the files themselves: codec and duration are measured, not taken from the agent.
    verify: `command -v ffprobe >/dev/null 2>&1 || { echo "ffprobe not found: ffmpeg is not installed"; exit 1; }
check() {
  out=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name:format=duration -of default=nw=1 "$1") || { echo "ffprobe cannot read $1"; return 1; }
  codec=$(printf '%s\\n' "$out" | sed -n 's/^codec_name=//p' | head -n 1)
  duration=$(printf '%s\\n' "$out" | sed -n 's/^duration=//p' | head -n 1)
  echo "$1: $codec, $duration s"
  case " $2 " in *" $codec "*) ;; *) echo "codec $codec is not one of: $2"; return 1 ;; esac
  awk -v d="$duration" 'BEGIN { exit !(d >= 1.8 && d <= 2.3) }' || { echo "duration $duration s is not about 2 s"; return 1; }
}
check /tmp/media/test.mp4 "h264" && check /tmp/media/test.webm "vp9 vp8"`,
  },
  {
    id: "webhook",
    title: "Webhook service on port 8095",
    prompt: `Write and start a small HTTP service on port 8095 that accepts POST requests to /hook with a JSON body, answers 200, and appends each body as one line of compact JSON to /tmp/hooks.log. It must keep running in the background after your commands return. Test it yourself with a POST.`,
    // Fresh nonces, posted from inside the sandbox: lines the agent wrote while testing cannot match them.
    verify: `n="osb$(date +%s)$$"
post() {
  body="{\\"nonce\\":\\"$n\\",\\"i\\":$1}"
  if command -v curl >/dev/null 2>&1; then curl -sS -m 5 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "$body" http://127.0.0.1:8095/hook
  elif command -v python3 >/dev/null 2>&1; then python3 -c "import sys, urllib.request as u; print(u.urlopen(u.Request('http://127.0.0.1:8095/hook', data=sys.argv[1].encode(), headers={'Content-Type': 'application/json'}), timeout=5).status)" "$body"
  else echo "no curl or python3 to POST with" >&2; return 1; fi
}
s1=$(post 1) || { echo "POST 1 failed"; exit 1; }
sleep 1
s2=$(post 2) || { echo "POST 2 failed"; exit 1; }
case "$s1 $s2" in 2??\\ 2??) ;; *) echo "POSTs answered $s1 and $s2"; exit 1 ;; esac
sleep 1
count=$(grep -c "$n" /tmp/hooks.log 2>/dev/null)
[ "\${count:-0}" -ge 2 ] || { echo "found \${count:-0} of the 2 posted bodies in /tmp/hooks.log"; exit 1; }
grep "$n" /tmp/hooks.log | tr -d ' ' | grep -q '"i":2' || { echo "the second body was not logged as sent"; exit 1; }
echo "both POSTs answered ($s1, $s2) and logged"`,
  },
];

export const taskById = new Map(TASKS.map(task => [task.id, task]));

/** Tasks selected when none are chosen: everything but the heavy ones. */
export const DEFAULT_TASKS = TASKS.filter(task => !task.heavy).map(task => task.id);
