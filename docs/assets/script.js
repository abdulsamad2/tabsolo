// Sidebar toggle on mobile
const sidebar = document.getElementById('sidebar');
const toggle = document.getElementById('menu-toggle');
if (toggle && sidebar) {
  toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
  sidebar.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') sidebar.classList.remove('open');
  });
}

// Scrollspy: highlight the sidebar link for the section currently in view.
const sections = Array.from(document.querySelectorAll('main section[id]'));
const navLinks = new Map(
  Array.from(document.querySelectorAll('.sidebar a')).map((a) => [a.getAttribute('href').slice(1), a])
);

const spy = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    const link = navLinks.get(entry.target.id);
    if (!link) return;
    if (entry.isIntersecting && entry.intersectionRatio > 0.15) {
      navLinks.forEach((a) => a.classList.remove('active'));
      link.classList.add('active');
    }
  });
}, { rootMargin: '-70px 0px -60% 0px', threshold: [0.15, 0.3, 0.6] });

sections.forEach((s) => spy.observe(s));
