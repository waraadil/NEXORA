'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
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
  reconnectPairing,
  type PairingState,
} from './whatsapp-actions';

/**
 * "Link your personal WhatsApp" — the guided flow.
 *
 * The whole point is that the user does not need to understand a socket, a
 * token, or an endpoint. They type their number, type the code that appears in
 * the app into WhatsApp, and are live. The command line is gone entirely.
 */

export type RelayView = {
  status: 'unpaired' | 'waiting' | 'connecting' | 'live' | 'offline' | 'unpaired_remote' | 'expired';
  lastSeenAt: string | null;
  selfNumber: string | null;
  selfName: string | null;
  pairingPhone: string | null;
  pairingExpiresAt: string | null;
  /** Decrypted for the authenticated owner only; null once revoked. */
  relayKey: string | null;
  /** The code WhatsApp issued, shown in the app so nothing is typed in a terminal. */
  pairingCode: string | null;
  lastError: string | null;
  autoReplyEnabled: boolean;
  requireApproval: boolean;
  delaySeconds: number;
  instructions: string | null;
  /** 'auto' | 'never' | 'match' — the user's explicit emoji instruction. */
  emojiPreference: 'auto' | 'never' | 'match';
  /** Conversations the user has explicitly allowed, for the switch's explainer. */
  allowedContacts: { id: string; title: string | null }[];
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
}: {
  relay: RelayView;
  drafts: DraftRow[];
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
  const [reconnecting, startReconnecting] = useTransition();
  const [reconnectNote, setReconnectNote] = useState<string | null>(null);

  // Server render on the first paint, polled value after that. The poll is the
  // only thing that can see a pairing advance while the tab stays open.
  const [polled, setPolled] = useState<{
    status: string;
    pairingCode: string | null;
    pairingExpiresAt: string | null;
    lastError: string | null;
    selfNumber: string | null;
    selfName: string | null;
  } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const status = polled?.status ?? relay.status;
  const live = status === 'live';
  // Only an OPEN pairing window is "waiting". A closed one is its own state — the
  // page used to treat both as waiting and trap the user on a dead spinner.
  const expired = status === 'expired';
  const waiting = (status === 'waiting' || status === 'connecting') && !expired;

  // The pairing window is 15 minutes. Show a live countdown so "nothing is
  // happening" is never just a guess.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const pairingExpiresAt = polled?.pairingExpiresAt ?? relay.pairingExpiresAt;
  useEffect(() => {
    if (!pairingExpiresAt || live) {
      setSecondsLeft(null);
      return;
    }
    const tick = () => {
      const left = Math.round((new Date(pairingExpiresAt).getTime() - Date.now()) / 1000);
      setSecondsLeft(left > 0 ? left : 0);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [pairingExpiresAt, live]);

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  // Nothing to paste and nothing to run: the agent posts the code back and the
  // card shows it. There is deliberately no command on this screen.
  //
  // The polled value wins whenever it exists, so a code that arrives after the
  // page was painted still appears. The server-rendered value is what the first
  // paint uses, and what a reload lands on.
  const pairingCode = polled?.pairingCode ?? relay.pairingCode;

  // The agent issues the code a moment or two after the claim is written, so
  // the card has to look for it. Without this the card sits on the spinner
  // until the user happens to press something — exactly the "it's stuck"
  // feeling this flow exists to remove.
  //
  // This used to call router.refresh(), and it did not work. The refreshed
  // payload really did contain the new code — verified on the wire — but React
  // kept rendering the props it already had, so the spinner stayed up while the
  // code was in the database and in the response. Only a manual reload ever
  // showed it, which is precisely the bug that was reported, twice.
  //
  // So the card fetches the few fields it needs itself and holds them in state.
  // There is no reconciler between the data and the screen that can drop it.
  useEffect(() => {
    if (!waiting) return;
    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch('/api/whatsapp/pairing-status', { cache: 'no-store' });
        if (!res.ok || !alive) return;
        const next = await res.json();
        if (!alive) return;
        setPolled(next);
        // Once the pairing leaves the waiting state, hand control back to the
        // server render so the live card (and everything below it) is the real
        // thing rather than a patched-up copy.
        if (next.status && next.status !== 'waiting' && next.status !== 'connecting') {
          setReloadKey((k) => k + 1);
        }
      } catch {
        // A dropped poll is not an error worth showing; the next one is 2s away.
      }
    };

    const first = setTimeout(tick, 800);
    const every = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(every);
    };
  }, [waiting]);

  // One refresh, after the pairing resolves, so the page catches up in full.
  const router = useRouter();
  useEffect(() => {
    if (reloadKey === 0) return;
    router.refresh();
  }, [reloadKey, router]);

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
            What keeps this connected?
          </summary>
          <div className="mt-3 space-y-2 text-sm text-muted-foreground">
            <p>
              The WhatsApp connection is held by a small always-on agent, not by your browser or your
              phone. Nothing on your side needs to stay open.
            </p>
            <p>
              Nothing on your side needs to stay open. If the agent itself stops, this card turns
              amber within three minutes rather than claiming to be connected.
            </p>
          </div>
        </details>
      </div>
    );
  }

  // ── Pairing in progress: the code appears HERE ──────────────────────────
  //
  // No command, no terminal. The always-on agent asks WhatsApp for the code and
  // posts it back, so it renders right here and auto-refreshes until the link
  // comes up.
  if (waiting) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Enter this code in WhatsApp</CardTitle>
              {secondsLeft !== null && (
                <Badge tone={secondsLeft > 60 ? 'primary' : 'warning'}>
                  {secondsLeft > 0
                    ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')} left`
                    : 'expired'}
                </Badge>
              )}
            </div>
            <CardDescription>
              Pairing {relay.pairingPhone ? `+${relay.pairingPhone}` : 'your number'} as a linked device,
              like WhatsApp Web. Your phone keeps working normally.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Steps current={2} />

            <div className="rounded-xl border border-primary/25 bg-primary/5 p-4">
              {pairingCode ? (
                <>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Your pairing code
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <p className="font-mono text-3xl font-semibold tracking-[0.18em] text-foreground">
                      {pairingCode}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => copy(pairingCode, 'code')}
                    >
                      {copied === 'code' ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </>
              ) : expired ? (
                // No code and the window is gone: say so. A spinner here is a
                // lie that never resolves — the exact thing this page is for.
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">This attempt has expired.</p>
                  <p className="text-sm text-muted-foreground">
                    WhatsApp codes are only good for 15 minutes, and no code was accepted in that
                    time. Nothing is broken — start again below.
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                  <p className="text-sm text-foreground">
                    Generating your code… this usually takes a few seconds.
                  </p>
                </div>
              )}
            </div>

            <ol className="space-y-1.5 text-sm text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">1.</span> On your phone open WhatsApp
              </li>
              <li>
                <span className="font-medium text-foreground">2.</span> Settings → Linked devices →
                Link a device → <span className="text-foreground">Link with phone number</span>
              </li>
              <li>
                <span className="font-medium text-foreground">3.</span> Type the code above
              </li>
            </ol>

            <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-muted-foreground">
              <p>
                This page updates by itself — you don’t need to refresh or press anything. Messages
                start arriving as soon as the code is accepted.
              </p>
              {expired ? (
                // The honest way out. This starts a brand-new 15-minute window on
                // the same number, so the user never needs to find a hidden
                // "start over" path — and never needs a terminal.
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    isLoading={reconnecting}
                    onClick={() => {
                      setReconnectNote(null);
                      startReconnecting(async () => {
                        const result = await reconnectPairing();
                        if (result?.error) setReconnectNote(result.error);
                      });
                    }}
                  >
                    Get a new code
                  </Button>
                  <form action={unlinkWhatsApp}>
                    <Button type="submit" variant="outline" size="sm">
                      Disconnect instead
                    </Button>
                  </form>
                </div>
              ) : (
                <div className="mt-2 flex items-center gap-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    isLoading={checking}
                    onClick={() =>
                      startChecking(async () => {
                        const result = await confirmPairing();
                        if (result?.error) setCheckNote(result.error);
                      })
                    }
                  >
                    Check now
                  </Button>
                  {checkNote && <span className="text-xs">{checkNote}</span>}
                </div>
              )}
              {expired && reconnectNote && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {reconnectNote}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/*
          There used to be an "Advanced: run the agent yourself" block here with a
          shell command in it. It was the only way out of a stuck pairing, which
          made a terminal step load-bearing for an ordinary user — exactly what
          this flow exists to remove. The hosted agent is now the only path; the
          command lives in relay/HOSTING.md for anyone self-hosting, where nobody
          can click it by accident.
        */}
      </div>
    );
  }

  // ── The last attempt ran out of time ────────────────────────────────────
  //
  // This is the state that trapped a real user: a pairing was started, the
  // 15-minute window closed, and the page kept showing a spinner under an
  // "expired" badge with no way to start again. Falling through to the
  // first-time form silently would also be wrong — it pretends nothing
  // happened. Say what happened, and put the way out right there.
  if (expired) {
    return (
      <div className="space-y-4">
        <Card className="border-warning/30 bg-warning-subtle">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">That pairing ran out of time</CardTitle>
              <Badge tone="warning">expired</Badge>
            </div>
            <CardDescription>
              A WhatsApp pairing code is only good for 15 minutes, and no code was accepted
              {relay.pairingPhone ? ` for +${relay.pairingPhone}` : ''} before the window closed.
              Nothing is broken — nothing was linked, and your phone was never touched.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Steps current={2} />
            <p className="text-sm text-muted-foreground">
              Getting a new code opens a fresh 15-minute window for the same number. Type it into
              WhatsApp straight away — the clock starts when the code appears.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                isLoading={reconnecting}
                onClick={() => {
                  setReconnectNote(null);
                  startReconnecting(async () => {
                    const result = await reconnectPairing();
                    if (result?.error) setReconnectNote(result.error);
                  });
                }}
              >
                Get a new code
              </Button>
              <form action={unlinkWhatsApp}>
                <Button type="submit" variant="outline" size="sm">
                  Use a different number
                </Button>
              </form>
            </div>
            {reconnectNote && (
              <p role="alert" className="text-sm text-destructive">
                {reconnectNote}
              </p>
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
            <p className="text-sm text-muted-foreground">
              Reconnecting takes one click — nothing to install and nothing to run.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                isLoading={reconnecting}
                onClick={() => {
                  setReconnectNote(null);
                  startReconnecting(async () => {
                    const result = await reconnectPairing();
                    if (result?.error) setReconnectNote(result.error);
                  });
                }}
              >
                Reconnect
              </Button>
              <form action={unlinkWhatsApp}>
                <Button type="submit" variant="outline" size="sm">
                  Disconnect and start over
                </Button>
              </form>
            </div>
            {reconnectNote && (
              <p role="alert" className="text-sm text-destructive">
                {reconnectNote}
              </p>
            )}
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
                Switches the feature on. It still answers <span className="text-foreground">nobody</span>{' '}
                until you allow each person in their conversation. Groups are never answered.
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
            label="Emoji"
            htmlFor="emoji"
            hint="What the AI may use when writing as you. It can never overrule this."
          >
            <select
              id="emoji"
              name="emoji"
              defaultValue={relay.emojiPreference}
              className="h-11 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm text-foreground"
            >
              <option value="never">Never use emoji</option>
              <option value="auto">At most one, only if it fits</option>
              <option value="match">Only if the other person used one</option>
            </select>
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

          {/* The switch alone is not enough information: someone turning this on
              and walking away deserves to know whether it will speak to anyone. */}
          <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
            {relay.allowedContacts.length === 0 ? (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Nobody is allowed yet.</span> Open a
                conversation and press “Allow AI replies” to add one person.
              </p>
            ) : (
              <>
                <p className="font-medium text-foreground">
                  Allowed ({relay.allowedContacts.length})
                </p>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  {relay.allowedContacts.slice(0, 6).map((c) => (
                    <li key={c.id} className="truncate">
                      · {c.title ?? 'Untitled'}
                    </li>
                  ))}
                  {relay.allowedContacts.length > 6 && (
                    <li>· and {relay.allowedContacts.length - 6} more</li>
                  )}
                </ul>
              </>
            )}
          </div>

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
