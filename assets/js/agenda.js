/* De agenda: koppelt het Scrollcraft-motorblok (scrollcraft.js, ongewijzigd) aan de pagina.
   Geen eigen gedrag: de kleur van het lasermoment is een cue van het motorblok, de zoom leest
   --sc-p in CSS. Laadt het motorblok niet, dan blijft de foto zwart-wit en werkt de lijst gewoon. */
if (window.ScrollCraft) window.ScrollCraft.mount(document.body);
