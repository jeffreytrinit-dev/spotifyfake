# Tidepool on your iPhone

This guide gets Tidepool onto your iPhone's home screen as an app, playing music from your
laptop. It takes about 15 minutes the first time. No networking knowledge needed.

**What you'll end up with:** a Tidepool icon on your home screen that opens full screen (no
Safari bars), keeps playing when you lock the phone, and shows song info and controls on the
lock screen.

**Why there's an "HTTPS" step:** iPhones only treat a website as a proper app (with offline
features later on) when the connection is secure, that is, the address starts with `https://`
and the phone trusts it. Both options below take care of that.

---

## Before you start

1. Tidepool is running on your laptop (`docker compose up -d`, see the README).
2. On the laptop, open <http://localhost:3000> in a browser. You should see Tidepool's sign-in
   or setup screen. If you do, you're ready.
3. Keep the laptop **on and awake** while you listen. Music streams from it.
   - Windows: *Settings → System → Power & battery → Screen and sleep*. Set "When plugged in,
     put my device to sleep after" to **Never**.
   - Linux (Ubuntu): *Settings → Power → Automatic Suspend* → off when plugged in.

## Pick one of two ways

|                          | **A. Tailscale** (recommended)              | **B. Home Wi-Fi only**                     |
| ------------------------ | ------------------------------------------- | ------------------------------------------ |
| Works away from home     | ✅ Yes, anywhere with internet               | ❌ Only on your home Wi-Fi                  |
| Extra app on the iPhone  | Tailscale (free)                            | None                                       |
| Certificate to install   | None, HTTPS is automatic                    | Once, by hand (5 taps)                     |
| If the laptop's address changes | Nothing to do                        | Redo a few steps                           |

---

## Option A: Tailscale (recommended)

Tailscale creates a private, encrypted network between your own devices. Your iPhone can then
reach the laptop from anywhere, and Tailscale provides a real, trusted HTTPS address
automatically. The personal plan is free.

### On the laptop

1. Go to <https://tailscale.com/download>, install Tailscale for Windows or Linux, and sign in
   (Google, Microsoft, Apple or GitHub accounts work). This creates your private network.
   - Linux: the page gives a one-line install command; afterwards run `sudo tailscale up` and
     follow the link it prints to sign in.
2. Open the admin page at <https://login.tailscale.com/admin/dns> and check two things:
   - **MagicDNS** is enabled (it normally is).
   - Under **HTTPS Certificates**, click **Enable HTTPS**.
3. Open a terminal:
   - Windows: press the Start key, type **PowerShell**, open it.
   - Linux: open **Terminal**.
4. Run this command. It tells Tailscale to publish Tidepool securely on your private network:

   ```
   tailscale serve --bg 3000
   ```

   (On Linux put `sudo` in front.) If it prints a link asking you to enable Serve, open the
   link, approve, and run the command again.

5. It prints an address like **`https://my-laptop.tail1234.ts.net`**. Write it down. That's your
   Tidepool address. (`--bg` keeps it running, also after a restart. See it again any time with
   `tailscale serve status`.)

### On the iPhone

6. Install **Tailscale** from the App Store. Open it, sign in with the **same account** as on the
   laptop, and allow it to add a VPN configuration when asked.
7. Make sure the switch in the Tailscale app is **on (Connected)**.
8. Open **Safari** (it must be Safari, not Chrome) and go to the address from step 5.
9. Sign in to Tidepool.
10. Continue with [Add it to your home screen](#add-it-to-your-home-screen) below.

> Tailscale on the phone only carries traffic to your own devices. Your other internet use goes
> out normally, and you can leave it switched on.

---

## Option B: Home Wi-Fi only

Here your laptop gives itself a security certificate, and you tell your iPhone to trust it,
once. Both devices must be on the same Wi-Fi.

### 1. Find your laptop's Wi-Fi address

This is a number like `192.168.1.23` or `10.0.0.15`.

- **Windows:** *Settings → Network & internet → Wi-Fi → (your network) → Properties*, look for
  **IPv4 address**. Or open PowerShell, type `ipconfig`, and look under "Wireless LAN adapter
  Wi-Fi" for **IPv4 Address**.
- **Linux:** open Terminal and type `hostname -I`. It's usually the first number.

> **Tip:** your router may give the laptop a different address after a restart. To stop that,
> log in to your router and look for "DHCP reservation" or "address reservation" for your
> laptop. If you skip this and the address changes, redo steps 2 and 5 with the new one.

### 2. Turn on HTTPS in Tidepool

Open the `.env` file in the Tidepool folder and set the address you found:

```
TIDEPOOL_LAN_IP=192.168.1.23
```

Then start Tidepool with the extra HTTPS part:

```
docker compose --profile lan-https up -d
```

### 3. Let the iPhone through the laptop's firewall

- **Windows:** if a window asks whether Docker may communicate on networks, choose **Private
  networks** and click **Allow**. Also check that your Wi-Fi is marked Private:
  *Settings → Network & internet → Wi-Fi → (your network) → Network profile type: Private*.
- **Linux (Ubuntu with ufw):** `sudo ufw allow 80,443/tcp`

### 4. Install the certificate on the iPhone (once)

5. On the iPhone, on the same Wi-Fi, open **Safari** and go to **`http://192.168.1.23/ca`**
   (your address, with `http`, not `https`). Safari says the website is trying to download a
   configuration profile. Tap **Allow**, then **Close**.
6. Open the **Settings** app. Near the top you'll see **Profile Downloaded**. Tap it (if it's
   not there: *General → VPN & Device Management*). Tap **Install**, enter your passcode, and
   tap **Install** again.
7. Still in Settings: *General → About → Certificate Trust Settings*. Turn on the switch next
   to **Caddy Local Authority** and tap **Continue**.

### 5. Open Tidepool

8. In Safari go to **`https://192.168.1.23`** (now with `https`). There should be no warning.
9. Sign in, then continue with [Add it to your home screen](#add-it-to-your-home-screen).

> **About the certificate:** it only makes your phone trust *your* laptop's Tidepool. It lives
> in Docker's `caddydata` volume. If you ever delete that volume, repeat steps 5–7, and first
> remove the old profile in *Settings → General → VPN & Device Management*. Remove it there any
> time you stop using Tidepool this way.

---

## Add it to your home screen

1. With Tidepool open in **Safari**, tap the **Share** button (the square with an arrow, at the
   bottom of the screen).
2. Scroll down and tap **Add to Home Screen**, then **Add**.
3. Close Safari and open **Tidepool from its new icon**. It opens full screen.
4. **Sign in again inside the app.** Home-screen apps keep their own sign-in, separate from
   Safari. You only need to do this once.

## Check that background playback works

1. Open an album and press **Play**.
2. Lock the phone. Music should keep playing, and the lock screen should show the song, the
   cover and play/pause/next/previous buttons.
3. Let a song finish while locked. The next one should start by itself.
4. Switch to another app. Music keeps playing.

**Volume:** use the iPhone's side buttons. iOS doesn't let web apps change the volume, so
Tidepool hides its volume slider on the iPhone.

**If music stops when you lock the phone or between songs, please tell me:**

- your iOS version (*Settings → General → About → iOS Version*),
- whether *Tidepool Settings → Sound processing on this iPhone* is on (try it **off** first:
  that setting is the most likely cause, and it takes effect after reopening the app),
- whether it stops **right when you lock** or **when the next song should start**.

That tells us whether to tune the web app or move to the native-app route (Capacitor) we
discussed.

---

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Safari can't open the page | Is the laptop awake, and is Tidepool running (<http://localhost:3000> on the laptop)? Option A: is Tailscale switched on, on **both** devices? Option B: is the phone on the same Wi-Fi (not mobile data), and is the address still the same (step 1)? |
| "This connection is not private" (Option B) | The certificate isn't trusted yet. Redo step 7 (Certificate Trust Settings). Make sure you used `https://` and your laptop's **number**, not `localhost`. |
| `tailscale` command not found (Windows) | Close PowerShell and open a new one after installing Tailscale. |
| Tailscale address doesn't load | Run `tailscale serve status` on the laptop. If it's empty, run `tailscale serve --bg 3000` again. Check that HTTPS is enabled in the admin page. |
| The home-screen icon is plain or shows a screenshot | Delete it, open the address in Safari once more, wait for the page to load fully, then add it again. |
| Asked to sign in every time | Make sure you open the app from the **icon**, not Safari. If it continues, remove and re-add the icon. |
| Music starts on the laptop instead of the phone | Phase 8 (device control) isn't built yet. Each device plays its own music for now. |
| Plays for a while, then stops after a long time | Check that the laptop didn't go to sleep (see "Before you start"). |
