/* Progressive screenshot viewer. The real image links work without JS. */
(() => {
  'use strict';
  const rail = document.getElementById('screen-gallery');
  const previous = document.getElementById('gallery-prev');
  const next = document.getElementById('gallery-next');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  if (rail && previous && next) {
    document.querySelector('.gallery-controls').hidden = false;
    const update = () => {
      previous.disabled = rail.scrollLeft < 2;
      next.disabled = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 2;
    };
    const move = direction => rail.scrollBy({left: direction * (rail.querySelector('.gallery-card').offsetWidth + parseFloat(getComputedStyle(rail).columnGap)), behavior: reduced.matches ? 'instant' : 'smooth'});
    previous.addEventListener('click', () => move(-1));
    next.addEventListener('click', () => move(1));
    rail.addEventListener('scroll', update, {passive:true});
    window.addEventListener('resize', update);
    update();
  }
  const dialog = document.getElementById('screen-dialog');
  if (!dialog || !dialog.showModal) return;
  const image = document.getElementById('screen-dialog-image');
  const caption = document.getElementById('screen-dialog-caption');
  const counter = document.getElementById('screen-counter');
  const links = [...document.querySelectorAll('a[href*="screenshots/"]')];
  const unique = [...document.querySelectorAll('.gallery-card > a')];
  let current = 0, opener = null;
  const zoom = document.getElementById('screen-zoom');
  zoom.addEventListener('click', () => {
    const expanded = dialog.classList.toggle('is-zoomed');
    zoom.setAttribute('aria-pressed', String(expanded)); zoom.textContent = expanded ? 'Fit screen' : 'Zoom in';
  });
  const display = index => {
    dialog.classList.remove('is-zoomed'); zoom.setAttribute('aria-pressed', 'false'); zoom.textContent = 'Zoom in';
    dialog.scrollTop = 0;
    current = (index + unique.length) % unique.length;
    const link = unique[current];
    image.src = link.href;
    image.alt = link.querySelector('img').alt;
    caption.textContent = link.dataset.caption || image.alt;
    counter.textContent = `${current + 1} / ${unique.length}`;
  };
  for (const link of links) link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); opener = link;
    display(unique.findIndex(item => item.href === link.href));
    document.documentElement.classList.add('dialog-open');
    dialog.showModal(); document.getElementById('screen-close').focus();
  });
  document.getElementById('screen-close').addEventListener('click', () => dialog.close());
  document.getElementById('screen-prev').addEventListener('click', () => display(current - 1));
  document.getElementById('screen-next').addEventListener('click', () => display(current + 1));
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') {event.preventDefault(); display(current + 1);}
    if (event.key === 'ArrowLeft') {event.preventDefault(); display(current - 1);}
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    document.documentElement.classList.remove('dialog-open');
    if (opener) opener.focus({preventScroll:true});
  });
})();
