# Pushing NEXORA to GitHub

The repository is fully committed and clean — 121 files, 1.1 MB, no secrets.
The only thing it needs is a credential.

## Why the push in this session failed

```
remote: No anonymous write access.
fatal: Authentication failed for 'https://github.com/waraadil/NEXORA.git/'
```

That is not a problem with your repository or remote (both are correct — the repo
exists and is currently empty). The sandbox running this session has no GitHub
credential: no `gh` CLI login, no `~/.git-credentials`, no `~/.netrc`, no
`GITHUB_TOKEN` in the environment. Git has no password to offer.

## Option A — you push (fastest, no token to share)

The repo is already committed and the remote is already set. From this workspace:

```bash
cd /home/user/nexora
git push -u origin main
```

Interactive git will prompt for a username and password. For the password, use a
**personal access token**, not your GitHub account password (GitHub removed
password auth for git operations in 2021):

1. github.com → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → Generate new token
2. Repository access: **Only select repositories** → `NEXORA`
3. Permissions: **Contents → Read and write**
4. Expiration: 7 days is plenty
5. Copy the token as the password when git prompts

Or run this on your own machine after cloning:
`git clone https://github.com/waraadil/NEXORA.git` will be empty, so instead
download the source archive from this workspace and push from your machine.

## Option B — give me a token

Paste a fine-grained token with `Contents: write` on `NEXORA` and I will push,
then watch the Vercel build to green. Revoke it afterwards — it will be in the
chat log either way.

```bash
git remote set-url origin https://<TOKEN>@github.com/waraadil/NEXORA.git
git push -u origin main
```

## After the push

The Vercel project `nexora` already exists with all five environment variables
set, but it is **not yet linked to this repository**. Link it once:

1. Vercel → `nexora` project → **Settings → Git** → Connect Git Repository →
   `waraadil/NEXORA`, production branch `main`
2. Every push to `main` deploys from then on.

The first build should succeed as-is: `next build` compiles clean locally
(23/23 routes) with the same environment variables.

Once deployed, set `NEXT_PUBLIC_APP_URL` in Vercel to the real domain, and add
that domain to Supabase → Authentication → URL Configuration.
