# Claude Code digest

A scheduled GitHub Actions job that emails you the new major Claude Code features
on a cadence you choose. It fetches the public changelog, has Claude filter it to
major functionalities, and sends the result by email through Resend.

Runs entirely on your personal GitHub account. No corporate account or local
machine is involved.

## How it works

1. The workflow runs daily and checks `state.json` for the last send date.
2. If `cadence_days` (in `config.yml`) have passed, it gathers the changelog and
   the release dates for the versions published since the last send.
3. Claude summarises those versions into major features, grouped by theme.
4. Resend emails the digest to you, and the new state is committed back.

If nothing happened between runs, `empty_digest` decides whether to send a short
"nothing major" note or stay silent.

## Configuration

All behaviour lives in `config.yml`. Edit that file, never the code. You can
change the tracked product(s), the cadence, the filter level, the output format,
the language and the model. To track a second product, add another entry under
`sources`.

The schedule hour (when the daily check runs) is the one setting in
`.github/workflows/digest.yml`, on the `cron` line. How often it actually sends
is `cadence_days` in `config.yml`.

## One-time setup

1. Create a new repo under your personal GitHub account and push these files.
2. Create an Anthropic API key at https://console.anthropic.com and add it as a
   repo secret named `ANTHROPIC_API_KEY`.
3. Create a Resend account at https://resend.com, signing up with the email you
   want the digest delivered to. Generate an API key and add it as the secret
   `RESEND_API_KEY`. Resend lets you send to your own sign-up address using its
   built-in sender with no domain setup.
4. Add two more secrets:
   - `EMAIL_TO`, the address that receives the digest.
   - `EMAIL_FROM`, the sender. Use `onboarding@resend.dev` until you verify your
     own domain in Resend.

Add secrets under repo Settings, Secrets and variables, Actions.

## Testing

Go to the Actions tab, pick the "Claude Code digest" workflow, and use Run
workflow. Two inputs are available:

- `force`, send even if the cadence is not yet due.
- `dry_run`, build and print the digest in the run log without sending or
  changing state.

For a first test, run with `force` on and `dry_run` on to preview, then with
`force` on and `dry_run` off to send a real email.

## Local dry run

With `js-yaml` installed and `ANTHROPIC_API_KEY` set in your shell:

```
npm install
npm run dry-run
```

This builds the digest and prints it without sending.
