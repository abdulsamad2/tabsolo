// Smooth-highlight the current section's nav link as you scroll.
const sections = Array.from(document.querySelectorAll('section[id]'));
const navLinks = new Map(
  Array.from(document.querySelectorAll('.nav-links a'))
    .map((a) => [a.getAttribute('href').slice(1), a])
);

const spy = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    const link = navLinks.get(entry.target.id);
    if (!link) return;
    if (entry.isIntersecting && entry.intersectionRatio > 0.25) {
      navLinks.forEach((a) => a.style.color = '');
      link.style.color = 'var(--text)';
    }
  });
}, { rootMargin: '-80px 0px -50% 0px', threshold: [0.25, 0.5] });

sections.forEach((s) => spy.observe(s));
