# ZYRO 360 Next Generation visual system – staging only

This branch adds the shared Android/web dual-theme stylesheet as the last site CSS import. It is not deployed to Render automatically until merged into the deployment branch.

No changes to app.js, server.mjs, SOS, GPS, map core, billing or chat handlers. Review layout in real browsers (Android, iOS and desktop), light and dark, map/SOS active, permissions, contact lists, premium subscriptions and emergency cards before enabling in production.

Android test build uses the same core stylesheet at app/src/main/assets/zyro-complete-visual-v126.css in cosmounivers93-maker/Zyro-360-Android.
