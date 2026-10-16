# Official-source research notes

Consulted October 15, 2026. These are documentation observations, not live API receipts. The source request required checking current official APIs before implementation.

| Source | Implementation relevance |
|---|---|
| https://docs.typesafe.ai/images | Experimental image opt-in, multipart assets, image preparation and limits |
| https://docs.typesafe.ai/api | System One endpoint, typed questions/answers and usage/error shape |
| https://docs.typesafe.ai/models | Explicit Jev model IDs and changing aliases |
| https://docs.typesafe.ai/primitives/noul | Structured match probability, not free-form action text |
| https://docs.typesafe.ai/primitives/choice | Alternative structured candidate selection; not used in this candidate |
| https://docs.typesafe.ai/primitives/box | Optional localization; not implemented |
| https://docs.discord.com/developers/activities/building-an-activity | Embedded SDK initialization, authorization and authentication flow |
| https://docs.discord.com/developers/activities/development-guides/networking | Activity URL mappings and proxy origin |
| https://docs.discord.com/developers/events/gateway | Gateway lifecycle, intents and attachment access |
| https://docs.discord.com/developers/topics/permissions | Permission bits, overwrites and role hierarchy |
| https://docs.discord.com/developers/resources/guild | Member timeout/kick/ban operations |

The provider's dedicated image page accepts Jev 1.13/1.14 while model-summary fields may present narrower modality descriptions. This candidate follows the image-specific protocol with an explicit version and treats live validation as a release gate; it does not infer stable production readiness from documentation alone. Moving aliases are intentionally avoided.

No TypeSafe persistent hosted reference library was assumed. No free API usage, unlimited throughput, exact accuracy, or image-token estimate was invented. Integration code and local tests remain independently inspectable.
