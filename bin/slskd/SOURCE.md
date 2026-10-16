# slskd for Entity

This directory includes slskd 0.26.0, distributed under GNU AGPL v3.
Upstream: https://github.com/slskd/slskd/tree/0.26.0
The corresponding modified source is included in `slskd-source.zip`.
Web participants can download it via the "slskd 소스" link in the footer.

Changes made for Entity on 2026-10-10:

- In DownloadService.cs, open downloads with FileShare.Read | FileShare.Delete so the original FLAC bytes can be served while downloading on Windows.
- In slskd.csproj, explicitly pin SQLitePCLRaw.lib.e_sqlite3 to 3.53.3 to update the bundled native SQLite library.

To reproduce the included self-contained win-x64 binary, extract the source ZIP,
install Microsoft .NET SDK 10, and run from the extracted slskd-0.26.0 directory:

```powershell
dotnet publish src/slskd/slskd.csproj -c Release -r win-x64 --self-contained true -p:RunAnalyzers=false -p:EnableNETAnalyzers=false -o entity-build
```

No global .NET SDK is required to run the distributed executable.
The AGPL license text is included as LICENSE. Third-party dependencies retain their own licenses.
