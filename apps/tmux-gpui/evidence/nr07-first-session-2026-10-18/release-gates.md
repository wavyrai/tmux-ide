# Installer and release-owner reconciliation — 18 October 2026

Inspected current Sfora cards #595 GP10, #563 PF06 and #609 NP12, checked-in `docs/public/install.sh`, and candidate evidence. All three cards remain open. Historical checkbox results on PF06 are not requalified by this audit.

| Owner | Current evidence | Still required for this mission |
| --- | --- | --- |
| GP10 #595 native install/update/removal | Transaction/recovery evidence remains historical. Current NR07 actual CLI2.9.7 package + standalone bridge setup/create/open/input passes on stock3.8 (1d966c46). | Exact new signed native artifact: fresh install, repeat, update, rollback, interruption/recovery and removal with preserved settings/sessions. The NR07 harness constructs managed paths itself; it does not execute the public installer. |
| PF06 #563 canonical installer | Checked-in native entry pins CLI2.9.6 and native-alpha-2026101702 with checksum verification. It refuses newer/unrecognized CLI versions rather than silently downgrading. | Coordinate verified CLI2.9.7 and new native artifacts, then update pins/checksums and rerun isolated customer journey. Verify HTTPS script bytes and supported platform installed doctor/app/recovery. Do not point to unpublished downloads. |
| NP12 #609 polished native release | Earlier unsigned candidate0.1.3/build2026101801 has historical package/split evidence; current onboarding/runtime changes are newer. | Build/qualify current exact native candidate, required GUI/local/SSH/platform checks, user test drive and second Mac, signing/notarization/stapling, exact signed install/update/rollback, public downloads and final merge/release evidence. |

Last retained signing attempt reported inaccessible notary profile; this audit did not access credentials or retry signing. Last native observation reported a locked Mac. Neither is a permanent availability claim. No new public endpoint, PR state, signing readiness or second-Mac result is inferred from local source.

Release order: qualify current source and candidate; finish physical/platform gates; publish independently verified CLI/native artifacts through supported release procedures; only then activate matching installer pins and verify customer downloads/upgrade. Keep branch implementation, qualification, merge and publication separate. No publication or installer mutation was performed by this audit.
