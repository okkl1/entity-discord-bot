# slskd for Entity (Northflank v4)

Upstream: https://github.com/slskd/slskd/tree/0.26.0
License: GNU AGPL v3 with upstream additional terms; see LICENSE.
The corresponding modified source is included in `slskd-source.zip` and served
through the web room's source download link. This cloud package contains source,
not a Windows executable. Docker builds the Linux executable from this source.

Changes for Entity:

- Downloads allow FileShare.Read | FileShare.Delete for Windows streaming.
- Pin SQLitePCLRaw.lib.e_sqlite3 to 3.53.3.
- Serialize search persistence/state callbacks and guard finalization against
  late callbacks, deletion, and cancellation before background scheduling.
- Publish each incoming peer response through the SignalR RESPONSE event.
- Reuse a single normalized response DTO for live events and final persistence.
  With ENTITY_MEMORY_PROFILE=compact, retain only FLAC file metadata, without
  retaining all other formats in a second raw response graph.

Reproduce the cloud executable from the extracted `slskd-0.26.0` directory
using Microsoft .NET SDK 10:

```sh
dotnet publish src/slskd/slskd.csproj -c Release -r linux-x64 --self-contained true -p:RunAnalyzers=false -p:EnableNETAnalyzers=false -p:PublishSingleFile=false -o entity-build
```

The Docker SDK build stage is excluded from the final runtime image. Native
regressions can be run with `dotnet run --project entity-search-regression -c Release`.
Third-party dependencies retain their own licenses.
