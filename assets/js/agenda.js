/* De agenda: koppelt het Scrollcraft-motorblok (scrollcraft.js, ongewijzigd) aan de pagina.
   Geen eigen gedrag: de kleur van het lasermoment is een cue van het motorblok, de zoom leest
   --sc-p in CSS. Laadt het motorblok niet, dan blijft de foto zwart-wit en werkt de lijst gewoon. */
if (window.ScrollCraft) window.ScrollCraft.mount(document.body);

/* De zwevende balk (Lester 9/11): verschijnt zodra het lasermoment weggescrold is, ook bij
   "Beperk beweging" (dan zonder animatie). Zonder dit script blijft hij weg. */
(function () {
  var root = document.documentElement, hero = document.querySelector(".hero"), queued = false;
  if (!hero) return;
  function check() {
    queued = false;
    root.classList.toggle("bar-on", hero.getBoundingClientRect().bottom < 72);
  }
  window.addEventListener("scroll", function () {
    if (!queued) { queued = true; requestAnimationFrame(check); }
  }, { passive: true });
  window.addEventListener("resize", check);
  check();
})();
