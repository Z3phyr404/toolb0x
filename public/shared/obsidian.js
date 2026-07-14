/* ============================================================
   OBSIDIAN — Shared Interactions (Glow + Scroll-Reveal)
   Einbinden per: <script nonce="__CSP_NONCE__" src="/shared/obsidian.js"></script>
   ============================================================ */

/**
 * Cursor-reaktiver Glow (Parallax + Bereichsfarbe)
 * @param {HTMLElement|string} scopeOrId — Root-Element oder ID-String
 */
function initGlow(scopeOrId) {
  var scope = typeof scopeOrId === 'string' ? document.getElementById(scopeOrId) : scopeOrId;
  if (!scope) scope = document.body;
  if (scope.dataset.glowReady) return;
  scope.dataset.glowReady = '1';

  var glows = scope.querySelectorAll('[data-glow]');
  if (!glows.length) {
    // Fallback: Glow-Elemente könnten auf Body-Level liegen
    glows = document.querySelectorAll('[data-glow]');
  }
  if (!glows.length) return;

  var primary = null;
  glows.forEach(function(g) { if (g.hasAttribute('data-glow-primary')) primary = g; });
  var baseBg = primary ? primary.style.background : '';

  // Mousemove auf dem gesamten Dokument (nicht nur scope), damit der Glow immer reagiert
  document.addEventListener('mousemove', function(e) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var rx = e.clientX / Math.max(vw, 1) - 0.5;
    var ry = e.clientY / Math.max(vh, 1) - 0.5;
    glows.forEach(function(g) {
      var d = parseFloat(g.dataset.depth || '40');
      g.style.transform = 'translate(' + (rx * d).toFixed(1) + 'px,' + (ry * d).toFixed(1) + 'px)';
    });
  });

  // Farb-Wechsel bei Karten-Hover
  scope.querySelectorAll('[data-glow-color]').forEach(function(card) {
    var c = card.getAttribute('data-glow-color');
    card.addEventListener('mouseenter', function() {
      if (primary) primary.style.background = 'radial-gradient(circle,' + c + ',transparent 70%)';
    });
    card.addEventListener('mouseleave', function() {
      if (primary) primary.style.background = baseBg;
    });
  });
}

/**
 * Scroll-Reveal (gestaffeltes Einblenden)
 * @param {HTMLElement|string} scopeOrId — Container oder ID-String
 */
function initReveal(scopeOrId) {
  var scope = typeof scopeOrId === 'string' ? document.getElementById(scopeOrId) : scopeOrId;
  if (!scope) scope = document.body;
  if (scope.dataset.revealReady) return;
  scope.dataset.revealReady = '1';

  var els = scope.querySelectorAll('[data-reveal]');
  if (!els.length) return;

  els.forEach(function(el) {
    el.style.opacity = '0';
    el.style.transform = 'translateY(22px)';
    el.style.transition = 'opacity 0.7s cubic-bezier(0.2,0.8,0.2,1), transform 0.7s cubic-bezier(0.2,0.8,0.2,1)';
  });
  var io = new IntersectionObserver(function(entries) {
    entries.forEach(function(en) {
      if (en.isIntersecting) {
        var el = en.target;
        var delay = (parseInt(el.dataset.revealIndex) || 0) * 65;
        setTimeout(function() {
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
        }, delay);
        io.unobserve(el);
      }
    });
  }, { threshold: 0.1 });
  els.forEach(function(el) { io.observe(el); });
}
