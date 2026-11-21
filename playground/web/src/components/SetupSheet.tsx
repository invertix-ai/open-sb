// Key setup for one provider (or Claude): each variable's status (never its value), inputs to set or replace
// it, Test connection, Save (tests first; "Save anyway" when the test fails) and Remove saved keys. Typed
// values leave the page state once saved.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LabelInput } from "@/bencho/label-input/LabelInput";
import "@/bencho/label-input/LabelInput.css";
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ProviderLogo } from "@/components/ProviderLogo";
import { api, del, post, put } from "@/lib/api";
import { fmt, safeUrl } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { ConnectionResult, CredentialStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS = { saved: "set (saved)", env: "set (from environment)", unset: "not set" } as const;

type Outcome = { test?: ConnectionResult; saved?: boolean; removed?: boolean } | null;

function testText(test: ConnectionResult) {
  if (test.ok) return `Connection works (${fmt(test.ms, "ms")})`;
  if (test.kind === "missing") return `Missing ${test.missing?.join(", ")}`;
  return `Connection failed: ${test.kind}${[test.code, test.status ? `HTTP ${test.status}` : ""].filter(Boolean).length ? ` (${[test.code, test.status ? `HTTP ${test.status}` : ""].filter(Boolean).join(", ")})` : ""}`;
}

/** A key field on the Label input block (bencho, adapted), sized to the sheet: the variable name is its label. */
function KeyField({ name, secret, value, onChange, hint }: { name: string; secret: boolean; value: string; onChange: (value: string) => void; hint: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    observer.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box} className="bencho w-full [&_.lbi-field]:font-mono">
      {width > 0 && <LabelInput label={name} secret={secret} value={value} onChange={onChange} hint={hint} width={width} corner={10} id={`f-${name}`} />}
    </div>
  );
}

export function SetupSheet() {
  const store = useStore();
  const module = store.setupModule;
  const [entry, setEntry] = useState<CredentialStatus | null>(null);
  const [path, setPath] = useState("~/.config/open-sb/credentials.json");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEntry(null); setValues({}); setOutcome(null); setError(null);
    if (!module) return;
    api<{ path: string; credentials: CredentialStatus[] }>("/api/credentials")
      .then(data => { setPath(data.path); setEntry(data.credentials.find(item => item.module === module) ?? null); })
      .catch(failure => setError((failure as Error).message));
  }, [module]);

  const typed = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value.trim()]).filter(([, value]) => value));
  const url = `/api/credentials/${encodeURIComponent(module ?? "")}`;

  async function run(action: "test" | "save" | "force" | "remove") {
    setBusy(action); setError(null);
    try {
      if (action === "test") {
        setOutcome(await post<{ test: ConnectionResult }>(`${url}/test`, { values: typed }));
        return;
      }
      const result = action === "remove"
        ? await del<{ removed: boolean; credential: CredentialStatus }>(url)
        : await put<{ saved: boolean; test: ConnectionResult; credential: CredentialStatus }>(url, { values: typed, force: action === "force" });
      setEntry(result.credential);
      setOutcome(result);
      if (!("saved" in result) || result.saved) {
        setValues({});
        toast.success(action === "remove" ? "Removed saved keys" : "Keys saved", { description: entry?.title });
        await store.loadOverview();
      }
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const saved = entry?.fields.some(field => field.status === "saved");
  const isClaude = module === "claude";

  return (
    <Sheet open={Boolean(module)} onOpenChange={open => { if (!open) store.openSetup(null); }}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b pb-4">
          <SheetTitle className="flex items-center gap-2.5">
            {module && !isClaude && <ProviderLogo module={module} size={28} />}
            Set up {entry?.title ?? (isClaude ? "Claude API key" : store.provider(module ?? "")?.title)}
          </SheetTitle>
          <SheetDescription>
            {isClaude ? "Used by the Agent test." : "Keys are tested with a cheap call that creates nothing."}
            {entry?.keyUrl && safeUrl(entry.keyUrl) && (
              <a href={safeUrl(entry.keyUrl)} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-1 text-foreground underline underline-offset-4">
                Get a key <ExternalLink className="size-3" />
              </a>
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5">
          {!entry && !error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading</div>}
          {entry && entry.fields.length === 0 && <p className="text-sm text-muted-foreground">{entry.title} needs no keys. Test connection checks that Docker is running.</p>}
          {entry?.fields.map(field => (
            <div key={field.name} className="space-y-1.5">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                {field.secret ? "secret" : "setting"}{!field.required && " · optional"}
                <Badge variant="outline" className={cn("ml-auto font-normal", field.status === "saved" && "border-success/40 text-success", field.status === "env" && "border-sidebar-primary/40 text-sidebar-primary")}>{STATUS[field.status]}</Badge>
              </div>
              <KeyField name={field.name} secret={field.secret} value={values[field.name] ?? ""}
                onChange={value => setValues(current => ({ ...current, [field.name]: value }))}
                hint={field.status === "saved" ? "Saved. Type to replace" : field.status === "env" ? "From the environment. Type to override" : field.secret ? "Paste the key" : "Value"} />
            </div>
          ))}
          {entry && entry.alternatives.length > 0 && (
            <p className="text-xs text-muted-foreground">Instead of the required variables, {entry.alternatives.map(set => set.join(" + ")).join(" or ")} also works (set in the environment).</p>
          )}

          {outcome?.saved === false && outcome.test && (
            <Alert className="border-warning/40">
              <XCircle className="text-warning" />
              <AlertTitle>{testText(outcome.test)}</AlertTitle>
              <AlertDescription>
                Nothing was saved.
                <Button size="sm" variant="outline" className="mt-2" disabled={Boolean(busy)} onClick={() => run("force")}>{busy === "force" && <Loader2 className="animate-spin" />}Save anyway</Button>
              </AlertDescription>
            </Alert>
          )}
          {outcome && outcome.saved !== false && (
            <Alert variant={outcome.test && !outcome.test.ok ? "destructive" : "default"} className={cn(outcome.test?.ok && "border-success/40")}>
              {outcome.test && !outcome.test.ok ? <XCircle /> : <CheckCircle2 className="text-success" />}
              <AlertTitle>{outcome.removed ? "Removed saved keys" : outcome.saved ? "Saved" : "Test connection"}</AlertTitle>
              {outcome.test && <AlertDescription>{testText(outcome.test)}</AlertDescription>}
            </Alert>
          )}
          {error && <Alert variant="destructive"><XCircle /><AlertTitle>Request failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}

          <Separator />
          <p className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>Saved keys go to <code className="font-mono">{path}</code>, readable only by you, and win over environment variables. They never come back to this page.</span>
          </p>
        </div>

        <SheetFooter className="flex-row border-t">
          {saved && <Button variant="ghost" className="text-destructive" disabled={Boolean(busy)} onClick={() => run("remove")}>{busy === "remove" && <Loader2 className="animate-spin" />}Remove saved keys</Button>}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" disabled={Boolean(busy) || !entry} onClick={() => run("test")}>{busy === "test" && <Loader2 className="animate-spin" />}Test connection</Button>
            {entry && entry.fields.length > 0 && <Button disabled={Boolean(busy) || Object.keys(typed).length === 0} onClick={() => run("save")}>{busy === "save" && <Loader2 className="animate-spin" />}Save</Button>}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
