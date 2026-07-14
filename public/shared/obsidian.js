/* ============================================================
   OBSIDIAN — Shared Interactions (Glow + Scroll-Reveal)
   Einbinden per: <script nonce="__CSP_NONCE__" src="/shared/obsidian.js"></script>
   ============================================================ */

/**
 * Cursor-reaktiver Glow (Parallax + Bereichsfarbe)
 * @param {HTMLElement} scope — Root-Element mit overflow:hidden + position:relative
 */
function initGlow(scope) {
  if (!scope || scope.dataset.glowReady) return;
  scope.dataset.glowReady = '1';
  var glows = scope.querySelectorAll('[data-glow]');
  var primary = scope.querySelector('[data-glow-primary]');
  var baseBg = primary ? primary.style.background : '';
  scope.addEventListener('mousemove', function(e) {
    var r = scope.getBoundingClientRect();
    var rx = (e.clientX - r.left) / Math.max(r.width, 1) - 0.5;
    var ry = (e.clientY - r.top) / Math.max(r.height, 1) - 0.5;
    glows.forEach(function(g) {
      var d = parseFloat(g.dataset.depth || '40');
      g.style.transform = 'translate(' + (rx * d).toFixed(1) + 'px,' + (ry * d).toFixed(1) + 'px)';
    });
  });
  scope.addEventListener('mouseleave', function() {
    glows.forEach(function(g) { g.style.transform = 'translate(0,0)'; });
  });
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
 * @param {HTMLElement} scope — Container mit [data-reveal]-Elementen
 */
function initReveal(scope) {
  if (!scope || scope.dataset.revealReady) return;
  scope.dataset.revealReady = '1';
  var els = scope.querySelectorAll('[data-reveal]');
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
