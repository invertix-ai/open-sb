// The agent capability tasks. Each has a prompt for the agent and a verify command the harness runs in the
// sandbox afterwards: exit code 0 means the task passed. Prompts assume a Debian-like image that may lack
// tools, and say how to install them.

export interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  verify: string;
}

export const SYSTEM_PROMPT = `You are an engineer working inside a fresh Linux sandbox (Debian-like) through two tools:
run_command runs a shell command and returns its exit code and output; write_file writes a whole file.
- Use absolute paths. Each run_command starts a new shell, so \`cd\` and exported variables do not carry over; use the cwd parameter or chain commands with &&.
- Tools may be missing. Install them with \`apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y <packages>\` (prefix with sudo if you are not root), or with pip.
- A command must return: start long-running processes in the background with nohup or setsid, redirect their output to a file, and do not wait on them.
- Work until the task is done and you have checked it yourself, then reply with a one-paragraph summary and stop calling tools.`;

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
];

export const taskById = new Map(TASKS.map(task => [task.id, task]));
