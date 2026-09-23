"""Render the shared-book flow locally: python3 tools/check_nightshelf_share_browser.py [capture-dir]."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import sys
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT)))
Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}/nightshelf/'
captures = Path(sys.argv[1]) if len(sys.argv) > 1 else None
if captures:
    captures.mkdir(parents=True, exist_ok=True)

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for width, height in [(390, 844), (320, 740), (1440, 1000)]:
            page = browser.new_page(viewport={'width': width, 'height': height}, reduced_motion='reduce')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            for book, title, edition in [
                ('pride_prejudice', 'Pride and Prejudice', 'Included with Nightshelf Pro'),
                ('wind_in_willows', 'The Wind in the Willows', 'Free on Nightshelf'),
                ('bedtime_real_princess', 'The Real Princess', 'Free on Nightshelf'),
                ('original_lantern_ferry', 'The Lantern Ferry', 'Free on Nightshelf'),
                ('original_evening_they_kept', 'The Evening They Kept', 'Free on Nightshelf'),
                ('original_borrowed_light', 'The Sea of Borrowed Light', 'Included with Nightshelf Pro'),
                ('original_tide_glass_observatory', 'The Tide-Glass Observatory', 'Free on Nightshelf'),
                ('original_garden_between_stations', 'The Garden Between Stations', 'Included with Nightshelf Pro'),
                ('original_space_between_replies', 'The Space Between Replies', 'Free on Nightshelf'),
                ('brick_moon', 'The Brick Moon', 'Free on Nightshelf'),
                ('canterville_ghost', 'The Canterville Ghost', 'Free on Nightshelf'),
                ('cousin_phillis', 'Cousin Phillis', 'Included with Nightshelf Pro'),
                ('great_stone_sardis', 'The Great Stone of Sardis', 'Included with Nightshelf Pro'),
                ('frankenstein', 'Frankenstein', 'Free on Nightshelf'),
                ('meditations', 'Meditations', 'Free on Nightshelf'),
                ('odyssey', 'The Odyssey', 'Included with Nightshelf Pro'),
                ('bedtime_snow_white', 'Snow White', 'Free on Nightshelf'),
                ('bedtime_cinderella', 'Cinderella', 'Included with Nightshelf Pro'),
                ('bedtime_sleepy_hollow', 'The Legend of Sleepy Hollow', 'Included with Nightshelf Pro'),
            ]:
                page.goto(base + '?book=' + book, wait_until='networkidle')
                assert page.locator('#shared-book').is_visible(), book
                assert page.locator('#shared-book-title').inner_text() == title
                assert page.locator('#shared-book-edition').inner_text() == edition
                assert page.locator('#shared-book-open').get_attribute('href') == 'nightshelf://book/' + book
                assert page.url == base + '?book=' + book
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), (width, book)
                if book.startswith('original_'):
                    assert page.locator('#shared-book-author').inner_text() == 'A Nightshelf Original'
                    assert 'Created with AI for Nightshelf.' in page.locator('#shared-book-description').inner_text()
                if captures and book in ['meditations', 'bedtime_snow_white', 'bedtime_cinderella']:
                    page.screenshot(path=str(captures / f'share-{book}-{width}.png'))
            for held in ['peter_pan', 'irish_fairy_tales', 'pinocchio', 'custom_private']:
                page.goto(base + '?book=' + held, wait_until='networkidle')
                assert page.locator('#shared-book').is_hidden()
            assert page.locator('h1').inner_text() == 'Stories to drift off to'
            page.goto(base, wait_until='networkidle')
            assert page.locator('#shared-book').is_hidden()
            if captures:
                page.screenshot(path=str(captures / f'home-{width}.png'), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), width
            assert not errors, errors
            page.close()
        browser.close()
    print('PASS: classics, familiar free/Pro selections, philosophy, prior and new free/Pro Originals, unknown and normal pages at 320px, 390px and 1440px; AI disclosure intact, no script errors or horizontal overflow')
finally:
    server.shutdown()
