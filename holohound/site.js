/* Progressive enhancement: all images and navigation work without JavaScript. */
(() => {
  const dialog = document.querySelector('.screen-dialog');
  const image = dialog?.querySelector('.dialog-image');
  const title = document.querySelector('#screen-dialog-title');
  let opener = null;
  if (dialog && typeof dialog.showModal === 'function') {
    document.querySelectorAll('.screen-open').forEach(link => {
      link.addEventListener('click', event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        opener = link;
        image.src = link.href;
        image.alt = link.querySelector('img').alt;
        title.textContent = link.dataset.title;
        dialog.showModal();
        dialog.scrollTop = 0;
        document.body.style.overflow = 'hidden';
      });
    });
    dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('button, a[href], [tabindex="0"]')].filter(control => !control.disabled);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    });
    dialog.addEventListener('click', event => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom)) dialog.close(); });
    dialog.addEventListener('close', () => { document.body.style.overflow = ''; opener?.focus({preventScroll:true}); });
  }
  const rail = document.querySelector('.screens-rail');
  const arrows = [...document.querySelectorAll('.gallery-arrow')];
  if (rail && arrows.length) {
    document.documentElement.classList.add('js-gallery');
    const update = () => {
      arrows[0].disabled = rail.scrollLeft < 2;
      arrows[1].disabled = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 2;
    };
    arrows.forEach(button => button.addEventListener('click', () => {
      const card = rail.querySelector('.screen-card');
      const distance = card.getBoundingClientRect().width + parseFloat(getComputedStyle(rail).gap);
      rail.scrollBy({left: Number(button.dataset.direction) * distance, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
    }));
    // Let native keyboard focus settle before aligning its card to the snap position.
    // Pointer focus must not move a card out from under an in-progress click.
    rail.addEventListener('focusin', event => {
      const target = event.target;
      const card = target.closest('.screen-card');
      if (!card || !target.matches(':focus-visible')) return;
      requestAnimationFrame(() => {
        if (document.activeElement !== target) return;
        const bounds = rail.getBoundingClientRect();
        const focused = target.getBoundingClientRect();
        if (focused.left >= bounds.left && focused.right <= bounds.right) return;
        rail.scrollTo({
          left: rail.scrollLeft + card.getBoundingClientRect().left - bounds.left,
          behavior: 'instant'
        });
      });
    });
    rail.addEventListener('scroll', update, {passive: true});
    addEventListener('resize', update);
    update();
  }
  const menu = document.querySelector('.mobile-menu');
  menu?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => { menu.open = false; }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu?.open) { menu.open = false; menu.querySelector('summary').focus(); } });
})();
