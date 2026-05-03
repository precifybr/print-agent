DALMAGO Print Agent build resources

This folder is reserved for production packaging assets.

Production packaging assets:

- icon.ico: Windows application and installer icon, generated from the provided Print Assistant artwork. Windows icon resources should include or be based on high-quality 256x256 artwork.
- icon.png: source artwork copy used to create icon.ico
- installer-sidebar.bmp: optional NSIS sidebar image
- installer-header.bmp: optional NSIS header image

The current packaging configuration intentionally uses standard Electron
Builder and NSIS behavior only. It does not use registry hacks, script
execution tricks, obfuscation, self-modifying code, or temporary executable
extraction patterns beyond the normal Electron Builder installer flow.

Unsigned builds can trigger Windows SmartScreen warnings when first
distributed. Production distribution should use:

- a signed Windows executable
- a signed NSIS installer
- a reputable code signing certificate
- stable release artifacts

Code signing is intentionally not configured here because certificates and
publisher credentials must never be committed to the repository.
