---
name: pipeline-cron
description: 'Schedule or update the WhatsApp-to-YouTube pipeline cron job. Use for: cron setup, daily scheduling, timezone-aware scheduling, enabling cron, verifying cron service, updating pipeline run time, checking pipeline_cron.log. Keywords: cron, crontab, scheduler, timezone, eastern time, EDT, EST, pipeline, daily job'
user-invocable: true
argument-hint: 'schedule or cron task (e.g. set 10 PM Eastern, verify cron, fix timezone drift)'
---

# Pipeline Cron

Use this skill to install, update, or verify the daily cron job for the WhatsApp-to-YouTube pipeline in this workspace.

## Workspace Facts

- Workspace: `$HOME/workspace`
- Pipeline script: `$HOME/workspace/download_and_upload.mjs`
- Node binary: `/usr/bin/node`
- Log file: `$HOME/workspace/pipeline_cron.log`
- Cron service name on this machine: `cron`

## Correct Approach

For Eastern Time schedules, prefer a timezone-aware cron entry instead of hard-coding UTC offsets. A fixed UTC entry drifts by one hour when Eastern switches between EDT and EST.

Use this crontab content:

```cron
CRON_TZ=America/New_York
# WhatsApp Video Downloader + YouTube Uploader — daily at 10:00 PM Eastern
0 22 * * * cd $HOME/workspace && /usr/bin/node $HOME/workspace/download_and_upload.mjs >> $HOME/workspace/pipeline_cron.log 2>&1
```

This keeps the job at 10:00 PM local Eastern time year-round.

## Installation Steps

1. Check the current crontab:

```bash
crontab -l
```

2. Install or replace the pipeline entry with the timezone-aware version:

```bash
cat <<'CRON' | crontab -
CRON_TZ=America/New_York
# WhatsApp Video Downloader + YouTube Uploader — daily at 10:00 PM Eastern
0 22 * * * cd $HOME/workspace && /usr/bin/node $HOME/workspace/download_and_upload.mjs >> $HOME/workspace/pipeline_cron.log 2>&1
CRON
```

3. Verify the crontab was installed:

```bash
crontab -l
```

4. Verify cron is running:

```bash
systemctl is-active cron
```

5. Verify cron is enabled at boot:

```bash
systemctl is-enabled cron
```

## Expected Verification Results

- `crontab -l` shows `CRON_TZ=America/New_York`
- `crontab -l` shows the `0 22 * * *` pipeline entry
- `systemctl is-active cron` returns `active`
- `systemctl is-enabled cron` returns `enabled`

## Notes

- The pipeline already deduplicates by `messageId`, skips already-uploaded videos, and deletes local files after successful upload.
- Cron runs non-interactively. If the YouTube OAuth token becomes invalid and requires browser re-authentication, run the pipeline manually once to refresh the token.
- Output is appended to `/home/ken/workspace/pipeline_cron.log`.

## Troubleshooting

### Cron entry exists but runs at the wrong hour

Cause: a fixed UTC schedule like `0 2 * * *` was used.

Fix: replace it with `CRON_TZ=America/New_York` and `0 22 * * *`.

### Cron service is not running

Start it:

```bash
sudo systemctl start cron
```

Enable it at boot:

```bash
sudo systemctl enable cron
```

### No output in the log file

Check whether the job has run yet and inspect system cron logs if needed. The pipeline log path is:

```bash
tail -n 100 /home/ken/workspace/pipeline_cron.log
```