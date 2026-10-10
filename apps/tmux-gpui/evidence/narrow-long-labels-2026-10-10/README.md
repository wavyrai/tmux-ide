# Narrow long-label physical check — incomplete

At branch 4876fa44, the separately packaged Split Count Physical app was resized from a 2000×1300 to a 1280×800 pixel screenshot (640×400 logical points at the observed 2× scale). Home showed the long session label ellipsized inside its card with Open visible. Screenshots were observed in the operator conversation, not saved here.

Opening that session showed `Catalog unavailable (open session: request failed; HTTP 503) — refresh catalog`. No input marker was entered. The fixture was still running; the operator closed the isolated app with Cmd-Q, producing the recorded `App closed before input proof` failure and executing cleanup. No narrow-layout observation signal was written. This is not a passed navigation/terminal-layout proof. The fixture uses long labels ending in spaces; whether the error is caused by that boundary is under investigation.

The user demos controlled by PIDs 93795 and 54706 were left running and untouched. Native app SHA-256: 31792088c01d1d5666476711d1e61f781381ef32b3d4664cbcc2f0af78c63bd3. Fixture SHA-256: 42230322bc45566ba96b5bb32a17ddebc3b5bfadef4bbda6982acc67fe3d6c58.
