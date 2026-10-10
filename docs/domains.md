# Little Code domain shortlist

**Checked 10 October 2026, 06:37 UTC / 12:07 IST.** The checks used authoritative registry RDAP endpoints identified by [IANA’s RDAP bootstrap directory](https://data.iana.org/rdap/dns.json). They describe registration records at that time, not guaranteed purchase availability.

| Recommendation | Registry observation | Product fit |
| --- | --- | --- |
| **littlecode.app** | [Google Registry](https://pubapi.registry.google/rdap/domain/littlecode.app) returned HTTP 404 | Preferred: exact product name and clear desktop-app identity. |
| **littlecode.build** | [CentralNic registry endpoint](https://rdap.centralnic.com/build/domain/littlecode.build) returned HTTP 404 | Strong alternative for a developer/building product. |
| **littlecode.tools** | [Identity Digital registry](https://rdap.identitydigital.services/rdap/domain/littlecode.tools) returned HTTP 404 | Fits the coding agent and its tool ecosystem. |

These three **look unregistered**. Confirm availability, reserved or premium status, registration cost and renewal cost at a registrar before buying. Registration status can change; a missing RDAP record does not guarantee the registry will allow registration. No domain was purchased or reserved during these checks.

## The `code.little.*` pattern

`code.little.app` is a subdomain of `little.app`. It requires control of that parent domain and cannot be purchased independently as a normal domain. The same relationship applies to `code.little.dev`, `code.little.tools` and other suffixes.

The [little.app registry record](https://pubapi.registry.google/rdap/domain/little.app) returned HTTP 200 in the 06:37 UTC check. Earlier checks at 06:24 UTC on the same date also returned registration records for [little.dev](https://pubapi.registry.google/rdap/domain/little.dev), [little.codes](https://rdap.identitydigital.services/rdap/domain/little.codes), [little.tools](https://rdap.identitydigital.services/rdap/domain/little.tools), [little.build](https://rdap.centralnic.com/build/domain/little.build) and [little.studio](https://rdap.identitydigital.services/rdap/domain/little.studio). Those records establish that the parent names are registered; they do not establish that the Little Code owner controls them.

If you already own a suitable parent, `code.<your-parent-domain>` is a useful product address. Otherwise, `littlecode.app` is the clearest candidate from this shortlist.

## Connect the chosen domain to Vercel

1. Deploy and review the website on its Vercel address using [the repository-root deployment settings](github-publication.md#deploy-the-website-on-vercel).
2. After buying a domain or confirming control of its parent, open the Vercel project’s **Settings → Domains** and add the exact domain or subdomain.
3. Apply the DNS and ownership-verification records Vercel displays for that project. Use those displayed values rather than copying guessed DNS targets from an example.
4. Wait for verification, confirm HTTPS and set any chosen apex/`www` redirects in the project.
5. Update the website’s canonical/social metadata to the actual production URL and redeploy. Verify the live site and its GitHub Release download.

Vercel documents the process in [Adding & Configuring a Custom Domain](https://vercel.com/docs/domains/working-with-domains/add-a-domain). A domain change does not move the installer into Vercel: the Windows setup remains a verified GitHub Release asset.
