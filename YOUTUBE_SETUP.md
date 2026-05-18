# YouTube OAuth Setup

The most reliable upload path is the official YouTube Data API with Google's OAuth browser consent flow. This opens a real browser window for authentication and stores a reusable refresh token locally.

## 1. Create Google OAuth credentials

1. Open Google Cloud Console.
2. Create or select a project.
3. Enable `YouTube Data API v3`.
4. Go to `APIs & Services -> Credentials`.
5. Create an `OAuth client ID`.
6. Choose `Desktop app`.
7. Download the JSON file.
8. Save it as `$HOME/workspace/youtube_client_secret.json`.

## 2. Run the standalone uploader

```bash
node youtube_oauth_upload.mjs /absolute/path/to/video.mp4 \
   --title "Test Upload" \
   --description "OAuth upload test" \
   --privacy private
```

What happens:
- a browser window opens to Google's consent screen
- you sign in and approve YouTube upload access
- the script stores the token in `$HOME/workspace/youtube_oauth_token.json`
- later uploads reuse that token without asking again unless Google revokes it

## 3. Files used

- OAuth client secrets: `$HOME/workspace/youtube_client_secret.json`
- OAuth token cache: `$HOME/workspace/youtube_oauth_token.json`
- Standalone uploader: `$HOME/workspace/youtube_oauth_upload.mjs`

## 4. Notes

- This is more reliable than cookie export or Selenium-based Studio automation.
- Use `private` for the first test upload.
- If you delete the token file, the browser consent flow will run again.
