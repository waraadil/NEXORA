'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BRIDGE_RISKS, CONFIRMATION_PHRASE } from '@/lib/whatsapp/bridge-risks';
import {
  beginPairing,
  confirmPairing,
  unlinkWhatsApp,
  updateAutoReply,
  decideDraft,
  type PairingState,
} from './whatsapp-actions';

/**
 * "Link your personal WhatsApp" — the guided flow.
 *
 * The whole point is that the user does not need to understand a bridge, a
 * token, or an endpoint. They type their number, copy one command, and are
 * live. Everything technical is behind the disclosure at the bottom.
 */

export type RelayView = {
  status: 'unpaired' | 'waiting' | 'connecting' | 'live' | 'offline' | 'unpaired_remote';
  lastSeenAt: string | null;
  selfNumber: string | null;
  selfName: string | null;
  pairingPhone: string | null;
  pairingExpiresAt: string | null;
  /** Decrypted for the authenticated owner only; null once revoked. */
  relayKey: string | null;
  lastError: string | null;
  autoReplyEnabled: boolean;
  requireApproval: boolean;
  delaySeconds: number;
  instructions: string | null;
  paused: boolean;
  pausedReason: string | null;
};

export type DraftRow = {
  id: string;
  body: string;
  toName: string;
  createdAt: string;
};

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" isLoading={pending} className="w-full">
      {pending ? busy : idle}
    </Button>
  );
}

function Steps({ current }: { current: 1 | 2 | 3 }) {
  const items = ['Link the relay', 'Scan or enter code', 'Live'];
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      {items.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const done = n < current;
        const active = n === current;
        return (
          <li key={label} className="flex items-center gap-1.5">
            <span
              className={[
                'flex size-5 items-center justify-center rounded-full border text-[10px] font-semibold',
                done
                  ? 'border-success/40 bg-success-subtle text-success'
                  : active
                    ? 'border-primary/50 bg-primary/15 text-primary'
                    : 'border-border-strong text-muted-foreground',
              ].join(' ')}
            >
              {done ? '✓' : n}
            </span>
            <span className={active ? 'font-medium text-foreground' : 'text-muted-foreground'}>{label}</span>
            {i < items.length - 1 && <span className="text-border-strong">›</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function WhatsappPersonal({
  relay,
  drafts,
  baseUrl,
}: {
  relay: RelayView;
  drafts: DraftRow[];
  baseUrl: string;
}) {
  const [stage, setStage] = useState<'closed' | 'details' | 'consent'>('closed');

  // React 19 resets uncontrolled inputs when a form action returns, which wiped
  // the phone number, every tick box and the phrase the moment validation
  // failed. These stay in React state so a rejection costs nothing.
  const [phone, setPhone] = useState(relay.pairingPhone ?? '');
  const [acks, setAcks] = useState<string[]>([]);
  const [phrase, setPhrase] = useState('');
  const toggleAck = (key: string) =>
    setAcks((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  const [state, action] = useActionState<PairingState, FormData>(beginPairing, null);
  const [copied, setCopied] = useState<string | null>(null);
  const [checking, startChecking] = useTransition();
  const [checkNote, setCheckNote] = useState<string | null>(null);

  const live = relay.status === 'live';
  const waiting = relay.status === 'waiting' || relay.status === 'connecting';

  // The pairing window is 15 minutes. Show a live countdown so "nothing is
  // happening" is never just a guess.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!relay.pairingExpiresAt || live) {
      setSecondsLeft(null);
      return;
    }
    const tick = () => {
      const left = Math.round((new Date(relay.pairingExpiresAt!).getTime() - Date.now()) / 1000);
      setSecondsLeft(left > 0 ? left : 0);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [relay.pairingExpiresAt, live]);

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  // Built from server state every render. A one-shot action result is lost on
  // any remount (including React's own after an action), which stranded users
  // mid-pairing with no command to run.
  //
  // One line, no npm login, no global install: the launcher downloads itself
  // and its dependencies into ~/.nexora-relay on first run.
  const command = relay.relayKey
    ? `NEXORA_URL=${baseUrl} NEXORA_PAIRING_CODE=${relay.relayKey} node -e "fetch('https://raw.githubusercontent.com/waraadil/NEXORA/main/relay/nexora-relay.mjs').then(r=>r.text()).then(t=>eval(t))"`
    : `NEXORA_URL=${baseUrl} NEXORA_PAIRING_CODE=<your key> node -e "…nexora-relay.mjs…"`;

  // ── Live ────────────────────────────────────────────────────────────────
  if (live) {
    return (
      <div className="space-y-4">
        <Card className="border-success/30 bg-success-subtle">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <span className="relative flex size-2.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex size-2.5 rounded-full bg-success" />
              </span>
              <div>
                <p className="text-sm font-medium">
                  {relay.selfName ? relay.selfName : 'Your WhatsApp'} is linked
                </p>
                <p className="text-xs text-muted-foreground">
                  {relay.selfNumber ? `+${relay.selfNumber}` : 'Personal account'} · messages arrive live
                  {relay.lastSeenAt ? ` · relay checked in ${timeAgo(relay.lastSeenAt)}` : ''}
                </p>
              </div>
            </div>
            <form action={unlinkWhatsApp}>
              <Button type="submit" variant="outline" size="sm">
                Disconnect
              </Button>
            </form>
          </CardContent>
        </Card>

        <AutoReplyPanel relay={relay} />

        {relay.requireApproval && drafts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Waiting for you to approve</CardTitle>
              <CardDescription>
                Approval mode is on, so NEXORA wrote these but did not send them.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {drafts.map((d) => (
                <div key={d.id} className="rounded-lg border border-border bg-surface-2 p-3">
                  <p className="mb-1 text-xs text-muted-foreground">
                    to {d.toName} · {timeAgo(d.createdAt)}
                  </p>
                  <p className="text-sm text-pretty">{d.body}</p>
                  <div className="mt-2.5 flex gap-2">
                    <form action={decideDraft}>
                      <input type="hidden" name="id" value={d.id} />
                      <input type="hidden" name="decision" value="approve" />
                      <Button type="submit" size="sm">
                        Send
                      </Button>
                    </form>
                    <form action={decideDraft}>
                      <input type="hidden" name="id" value={d.id} />
                      <input type="hidden" name="decision" value="reject" />
                      <Button type="submit" size="sm" variant="ghost">
                        Discard
                      </Button>
                    </form>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <details className="group rounded-xl border border-border bg-surface/60 p-4">
          <summary className="cursor-pointer list-none text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
            Running the relay — what to do if you restart your computer
          </summary>
          <div className="mt-3 space-y-2 text-sm text-muted-foreground">
            <p>
              The relay runs in the terminal window you opened. Close it and messages stop arriving —
              NEXORA shows this page honestly, it does not pretend otherwise. Start it again with the
              same command and it reconnects without re-pairing.
            </p>
            <pre className="overflow-x-auto rounded-lg bg-muted p-2.5 font-mono text-[11px] text-foreground">
{`NEXORA_URL=${baseUrl} NEXORA_PAIRING_CODE=${relay.relayKey ?? '<your key>'} \
  node -e "fetch('https://raw.githubusercontent.com/waraadil/NEXORA/main/relay/nexora-relay.mjs').then(r=>r.text()).then(t=>eval(t))"`}
            </pre>
            <p>
              Your pairing key is stored on this device only. If you have lost it, disconnect here and
              pair again — it takes a minute.
            </p>
          </div>
        </details>
      </div>
    );
  }

  // ── Waiting for the relay ───────────────────────────────────────────────
  if (waiting) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Finish linking</CardTitle>
              {secondsLeft !== null && (
                <Badge tone={secondsLeft > 60 ? 'primary' : 'warning'}>
                  {secondsLeft > 0 ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')} left` : 'expired'}
                </Badge>
              )}
            </div>
            <CardDescription>
              One copy-paste on your computer. The window below does the pairing for you.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Steps current={2} />

            <div className="space-y-1.5">
              <p className="text-sm font-medium">1. Copy this into a terminal</p>
              <div className="flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-ink/60 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                  {command}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => copy(command, 'cmd')}
                  className="shrink-0"
                >
                  {copied === 'cmd' ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Needs Node 20+. It installs in about a minute, then prints a pairing code.
              </p>
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-medium">2. Enter the code it prints</p>
              <p className="text-sm text-muted-foreground text-pretty">
                On your phone: <span className="text-foreground">WhatsApp → Settings → Linked devices → Link a device → Link with phone number</span>, then type the 8 characters from the terminal. That is the whole pairing — a linked device, like WhatsApp Web.
              </p>
            </div>

            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
              <p className="text-sm text-foreground">
                This page updates by itself when the link comes up. Keep it open.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2"
                isLoading={checking}
                onClick={() =>
                  startChecking(async () => {
                    const result = await confirmPairing();
                    setCheckNote(result?.error ?? 'Still waiting for the relay…');
                  })
                }
              >
                Check now
              </Button>
              {checkNote && <p className="mt-2 text-xs text-muted-foreground">{checkNote}</p>}
            </div>

            {relay.relayKey && (
              <details className="rounded-lg border border-border bg-surface-2 p-3">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                  Your pairing key (only if you need to re-run the command)
                </summary>
                <div className="mt-2 flex items-start gap-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-[11px]">{relay.relayKey}</code>
                  <Button type="button" variant="ghost" size="sm" onClick={() => copy(relay.relayKey!, 'key')}>
                    {copied === 'key' ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Treat it like a password: anyone with it can read WhatsApp under your account.
                </p>
              </details>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── A previous session exists but is not running ────────────────────────
  if (relay.status === 'offline' && relay.selfNumber) {
    return (
      <div className="space-y-4">
        <Card className="border-warning/30 bg-warning-subtle">
          <CardHeader>
            <CardTitle className="text-base">Relay is not running</CardTitle>
            <CardDescription>
              This account was linked before ({relay.selfNumber ? `+${relay.selfNumber}` : 'personal'}) but
              stopped reporting in {relay.lastSeenAt ? timeAgo(relay.lastSeenAt) : 'a while ago'}. Messages
              are not arriving right now.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <pre className="overflow-x-auto rounded-lg bg-muted p-2.5 font-mono text-[11px]">
{`cd nexora-relay
NEXORA_URL=${baseUrl} NEXORA_PAIRING_CODE=<your key> node relay.mjs`}
            </pre>
            <div className="flex flex-wrap gap-2">
              <form action={unlinkWhatsApp}>
                <Button type="submit" variant="outline" size="sm">
                  Disconnect and start over
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Not linked ──────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Link your personal WhatsApp</CardTitle>
          <CardDescription>
            Your real number, your existing chats. Live in two steps and about two minutes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Steps current={1} />

          <ul className="space-y-1.5 text-sm text-muted-foreground">
            <li>· Messages arrive in NEXORA as they are sent — no exporting files.</li>
            <li>· The AI can answer for you, in your voice, with a switch you control.</li>
            <li>· Your phone keeps working normally. This is a linked device, like WhatsApp Web.</li>
          </ul>

          {stage === 'closed' && (
            <Button className="w-full" onClick={() => setStage('details')}>
              Get started
            </Button>
          )}

          {stage !== 'closed' && (
            <form action={action} className="space-y-3">
              <Field
                label="Your WhatsApp number"
                htmlFor="phone"
                required
                hint="Country code first, digits only. India: 91 followed by the 10-digit number."
                error={state?.fieldErrors?.phone}
              >
                <Input
                  id="phone"
                  name="phone"
                  inputMode="numeric"
                  autoComplete="tel"
                  placeholder="919876543210"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                />
              </Field>

              {stage === 'details' && (
                <Button type="button" variant="outline" className="w-full" onClick={() => setStage('consent')}>
                  Continue
                </Button>
              )}

              {stage === 'consent' && (
                <>
                  <div className="rounded-lg border border-destructive/35 bg-destructive-subtle/40 p-3.5">
                    <p className="text-sm font-medium text-foreground">Before you turn this on</p>
                    <ul className="mt-2 space-y-2">
                      {BRIDGE_RISKS.map((r) => (
                        <li key={r.key}>
                          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                            <input
                              type="checkbox"
                              name="ack"
                              value={r.key}
                              checked={acks.includes(r.key)}
                              onChange={() => toggleAck(r.key)}
                              className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
                            />
                            <span>
                              <span className="font-medium text-foreground">{r.title}.</span>{' '}
                              <span className="text-muted-foreground">{r.detail}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <Field
                    label="Type to confirm"
                    htmlFor="confirm"
                    required
                    hint={`Exactly: ${CONFIRMATION_PHRASE}`}
                  >
                    <Input
                      id="confirm"
                      name="confirm"
                      placeholder={CONFIRMATION_PHRASE}
                      autoComplete="off"
                      value={phrase}
                      onChange={(e) => setPhrase(e.target.value)}
                      required
                    />
                  </Field>

                  {state?.error && (
                    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
                      {state.error}
                    </div>
                  )}

                  <Submit idle="Create pairing code" busy="Preparing…" />
                </>
              )}
            </form>
          )}

          {relay.lastError && stage !== 'closed' && (
            <p className="text-xs text-muted-foreground">Last attempt said: {relay.lastError}</p>
          )}
        </CardContent>
      </Card>

      <details className="rounded-xl border border-border bg-surface/60 p-4">
        <summary className="cursor-pointer list-none text-sm font-medium text-muted-foreground hover:text-foreground">
          What NEXORA can and cannot see
        </summary>
        <div className="mt-3 space-y-2 text-sm text-muted-foreground">
          <p>
            <span className="text-foreground">Can:</span> read messages sent to you and from you while the
            relay is running, and send messages you or the AI write.
          </p>
          <p>
            <span className="text-foreground">Cannot:</span> read your message history before linking
            (unless you export it), decrypt backups, see your password, or act as your phone.
          </p>
          <p>
            <span className="text-foreground">Never:</span> auto-reply in group chats, or auto-reply at all
            until you switch it on.
          </p>
        </div>
      </details>
    </div>
  );
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// ── Auto-reply controls ─────────────────────────────────────────────────────

function AutoReplyPanel({ relay }: { relay: RelayView }) {
  const [on, setOn] = useState(relay.autoReplyEnabled);
  const [approval, setApproval] = useState(relay.requireApproval);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">AI replies</CardTitle>
            <CardDescription>
              Answer people automatically, in your voice, while the relay is running.
            </CardDescription>
          </div>
          <Badge tone={relay.paused ? 'warning' : on ? 'success' : 'neutral'}>
            {relay.paused ? 'paused' : on ? 'on' : 'off'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <form
          action={async (fd) => {
            const result = await updateAutoReply(fd);
            setSaved(result?.success ?? result?.error ?? null);
          }}
          className="space-y-3.5"
        >
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface-2 p-3">
            <input
              type="checkbox"
              name="enabled"
              checked={on}
              onChange={(e) => setOn(e.target.checked)}
              className="mt-0.5 size-4 accent-[hsl(var(--primary))]"
            />
            <span className="text-sm">
              <span className="font-medium text-foreground">Reply automatically</span>
              <span className="block text-muted-foreground">
                One-to-one chats only. Groups are never auto-answered.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface-2 p-3">
            <input
              type="checkbox"
              name="approval"
              checked={approval}
              onChange={(e) => setApproval(e.target.checked)}
              className="mt-0.5 size-4 accent-[hsl(var(--primary))]"
            />
            <span className="text-sm">
              <span className="font-medium text-foreground">Ask me before sending</span>
              <span className="block text-muted-foreground">
                Drafts wait here for approval instead of going out. Slower, but nothing leaves unseen.
              </span>
            </span>
          </label>

          <Field label="Wait before replying (seconds)" htmlFor="delay" hint="A human pause. 0–120.">
            <Input
              id="delay"
              name="delay"
              type="number"
              min={0}
              max={120}
              defaultValue={relay.delaySeconds}
              className="max-w-28"
            />
          </Field>

          <Field
            label="Standing instructions (optional)"
            htmlFor="instructions"
            hint="For example: “I’m at work until 6, say I’ll call back later.”"
          >
            <Textarea
              id="instructions"
              name="instructions"
              rows={2}
              defaultValue={relay.instructions ?? ''}
              placeholder="Keep it short — anything you want the AI to know before it answers."
            />
          </Field>

          {relay.paused && relay.pausedReason && (
            <p className="rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning">
              {relay.pausedReason} Turn it back on to resume.
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" size="sm">
              Save
            </Button>
            {saved && <span className="text-xs text-muted-foreground">{saved}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
