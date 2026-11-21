# Installing Laytekz

Laytekz is a LaTeX editor you share with other people: you write, the PDF
updates as you go, and collaborators can edit the same document at the same
time. This app opens a Laytekz server in its own window: by default the one at
<https://laytekz.devon7y.com>, or another server you choose with **Change
Server…** in the app's menu.

## Which file do I need?

| Your computer | Download |
| --- | --- |
| Mac with Apple silicon (M1, M2, M3, M4 or later) | `Laytekz-1.0.0-mac-arm64.dmg` |
| Mac with an Intel processor | `Laytekz-1.0.0-mac-x64.dmg` |
| Windows PC (almost all PCs) | `Laytekz-1.0.0-win-x64-setup.exe` |
| Windows PC with an ARM processor (Snapdragon, some Surface models) | `Laytekz-1.0.0-win-arm64-setup.exe` |

Not sure which one you have?

- **Mac:** Apple menu → **About This Mac**. "Chip: Apple M…" means Apple silicon.
  "Processor: … Intel …" means Intel.
- **Windows:** **Settings → System → About**, then look at **System type**:
  "x64-based processor" or "ARM-based processor".

The `.zip` files hold the same Mac app as the `.dmg` files, so either works.
You need macOS 13 (Ventura) or later, or 64-bit Windows 10 or 11. The version
number in the file names changes with each new release.

## Why does my computer warn me?

The app is not signed with a paid Apple or Microsoft developer certificate.
Without one, macOS and Windows cannot tell who made the app, so they warn you
the first time you open it. The warning does not mean anything was found in
the app. Only install a copy downloaded from the project's
[Releases page](https://github.com/Computational-Memory-Lab/laytekz/releases).
To be extra sure, check the checksum (see the end of this page).

## Mac

1. Open the `.dmg` file and drag **Laytekz** onto the **Applications** folder.
   Then open Laytekz from Applications, not from the disk image.
2. macOS says **"Laytekz" Not Opened** (Apple could not verify it is free of
   malware). Click **Done**.
3. Open **System Settings → Privacy & Security** and scroll down to
   **Security**. Next to "Laytekz was blocked to protect your Mac", click
   **Open Anyway**. Click **Open Anyway** again and enter your password or use
   Touch ID. The button stays there for about an hour after step 2.
4. Laytekz opens. From now on it opens normally.

On macOS 14 (Sonoma) or earlier, there is a shortcut: Control-click Laytekz in
Applications, choose **Open**, then click **Open** again.

If macOS says **"Laytekz" is damaged and can't be opened**, macOS has refused
the unsigned download; the file is usually fine. Check the checksum first. If
it matches, open **Terminal**, paste this line and press Return, then open
Laytekz again:

```sh
xattr -dr com.apple.quarantine /Applications/Laytekz.app
```

## Windows

1. If your browser says the file "isn't commonly downloaded", keep it. In
   Edge: point at the download, click **⋯**, then **Keep**, **Show more** and
   **Keep anyway**.
2. Open the installer. Windows shows **Windows protected your PC**. Click
   **More info**, then **Run anyway**.
3. Follow the installer. It installs Laytekz for your Windows account only,
   so you do not need administrator rights. It adds a Start menu shortcut and
   a desktop shortcut.

If Windows says **Smart App Control** blocked the app, there is no
Run anyway button. Smart App Control (Windows 11) blocks unsigned apps it does
not know. Laytekz can only be installed if Smart App Control is turned off
(Windows Security → App & browser control → Smart App Control). That lowers
the protection for every app, so decide whether you want to, or ask whoever
looks after the computer.

## Signing in

1. Open Laytekz and click **Continue with Google**. Your web browser opens on
   Google's sign-in page. (Google does not allow sign-in inside apps like
   this one, so it happens in your browser.)
2. Choose your Google account.
   - If Google says it hasn't verified the app, click **Continue**.
   - If Google says **Access blocked**, your address is not on the server's
     list yet. Ask the administrator to add it.
3. The browser says **You are signed in. Return to Laytekz.** Close the tab.
   The app is now signed in.

**The first time:** a new account has to be approved by the administrator.
The browser then shows **Waiting for approval**, and after 5 minutes the app
stops waiting. Once you have been approved, click **Continue with Google**
again.

## Updating

Laytekz does not update itself. When there is a new version, download the new
file for your computer and install it over the old one. You stay signed in
and keep your settings.

- **Mac:** quit Laytekz, drag the new Laytekz onto Applications and choose
  **Replace**. Do the Privacy & Security steps above once more. macOS may
  also ask whether Laytekz may use **"Laytekz Safe Storage"** in your
  keychain: enter your Mac password and click **Always Allow**. (If you click
  Deny, you only have to sign in again.)
- **Windows:** quit Laytekz and run the new installer. Click **More info →
  Run anyway** again. It replaces the old version.

## Removing Laytekz

- **Mac:** drag Laytekz from Applications to the Bin. Its settings are in
  `~/Library/Application Support/Laytekz`.
- **Windows:** **Settings → Apps → Installed apps → Laytekz → Uninstall**.

Your documents are not on your computer: they stay on the Laytekz server.

## Checking the download (optional)

`SHA256SUMS.txt` lists a checksum for every file. Compute the checksum of the
file you downloaded and compare it with the line for that file:

- **Mac** (Terminal): `shasum -a 256 ~/Downloads/Laytekz-1.0.0-mac-arm64.dmg`
- **Windows** (PowerShell): `Get-FileHash $HOME\Downloads\Laytekz-1.0.0-win-x64-setup.exe`
  (Windows prints it in capital letters; it is the same value.)

If the two do not match, do not open the file. Download it again from the
Releases page.
