import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCREENSHOT_DIR = 'C:\\Users\\sidro\\AppData\\Local\\Temp\\claude\\C--Users-sidro-all-code-clients-suyashh-best-roadways\\1704fdc8-a081-4f6e-b88a-100ff96dcf5a\\scratchpad';
const BASE_URL = 'http://localhost:4330';

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function run() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const reports = [];

  try {
    // Set viewport
    await page.setViewport({ width: 1440, height: 900 });
    reports.push('✓ Viewport set to 1440x900');

    // Step 1: Navigate to app
    console.log('Navigating to app...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    reports.push('✓ App loaded at ' + BASE_URL);

    // Step 2: Navigate to Notifications page
    console.log('Looking for Notifications button in sidebar...');
    const navButton = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const notifBtn = buttons.find(btn => btn.textContent.trim() === 'Notifications');
      if (notifBtn) {
        notifBtn.click();
        return true;
      }
      return false;
    });

    if (!navButton) {
      throw new Error('Notifications button not found in sidebar');
    }
    reports.push('✓ Clicked Notifications button');

    // Wait for navigation
    await new Promise(resolve => setTimeout(resolve, 1500));
    reports.push('✓ Waited 1500ms for page load');

    // Step 3: Screenshot 1 - Initial state
    console.log('Taking screenshot 1 (initial)...');
    const screenshotPath1 = path.join(SCREENSHOT_DIR, 'notif-1-initial.png');
    await page.screenshot({ path: screenshotPath1, fullPage: true });
    reports.push(`✓ Screenshot saved: notif-1-initial.png`);

    // Analyze layout - check if two columns
    const layout1 = await page.evaluate(() => {
      // Find Recipients section - could be a card, div, or section with "Recipients" text
      const elements = Array.from(document.querySelectorAll('*'));
      let recipientsContainer = null;

      for (const el of elements) {
        const text = el.textContent || '';
        if (text.includes('Recipients') && el.children.length > 0) {
          recipientsContainer = el;
          break;
        }
      }

      if (!recipientsContainer) {
        return { found: false, msg: 'Recipients section not found', twoColumn: false };
      }

      const rect = recipientsContainer.getBoundingClientRect();

      // Look for child containers that might represent columns
      const directChildren = Array.from(recipientsContainer.children);

      // Check for sidebar-type pattern or grid pattern
      const isTwoColumn = directChildren.length >= 2;

      // Get dimensions
      return {
        found: true,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        childCount: directChildren.length,
        twoColumn: isTwoColumn,
        msg: isTwoColumn ? 'Two-column layout detected' : 'Single-column or unclear layout'
      };
    });
    reports.push(`Layout Check 1: ${JSON.stringify(layout1)}`);

    // Check for cramping/overflow in recipient rows
    const rowsHealth1 = await page.evaluate(() => {
      // Find elements that look like recipient rows
      const rows = Array.from(document.querySelectorAll('div[class*="recipient"], div[class*="Recipient"], tr, li'))
        .filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.height > 0 && rect.height < 150; // Typical row height
        });

      const issues = [];
      rows.slice(0, 5).forEach((row, idx) => {
        const rect = row.getBoundingClientRect();
        const scrollWidth = row.scrollWidth;
        const offsetWidth = row.offsetWidth;

        if (scrollWidth > offsetWidth + 2) {
          issues.push(`Row ${idx}: horizontal overflow (scroll:${scrollWidth} > offset:${offsetWidth})`);
        }

        // Check for text overflow/clipping
        const hasOverflow = row.style.overflow === 'hidden' || row.style.textOverflow === 'ellipsis';
        if (hasOverflow && scrollWidth > offsetWidth) {
          issues.push(`Row ${idx}: text clipped (ellipsis active)`);
        }
      });

      return {
        rowCount: rows.length,
        overflowIssues: issues.length > 0,
        details: issues.length > 0 ? issues : ['No visible overflow issues']
      };
    });
    reports.push(`Rows Health 1: ${JSON.stringify(rowsHealth1)}`);

    // Step 4: Click "Add recipient" button
    console.log('Looking for Add recipient button...');
    const addBtnClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const addBtn = buttons.find(btn => btn.textContent.toLowerCase().includes('add recipient'));
      if (addBtn) {
        addBtn.click();
        return true;
      }
      return false;
    });

    if (!addBtnClicked) {
      throw new Error('Add recipient button not found');
    }
    reports.push('✓ Clicked Add recipient button');

    // Wait for new card
    await new Promise(resolve => setTimeout(resolve, 800));
    reports.push('✓ Waited 800ms for editor card');

    // Step 5: Screenshot 2 - After adding
    console.log('Taking screenshot 2 (after add)...');
    const screenshotPath2 = path.join(SCREENSHOT_DIR, 'notif-2-added.png');
    await page.screenshot({ path: screenshotPath2, fullPage: true });
    reports.push(`✓ Screenshot saved: notif-2-added.png`);

    // Check if new editor card appeared at top
    const layout2 = await page.evaluate(() => {
      // Look for visible input/textarea elements that appeared
      const editors = Array.from(document.querySelectorAll('input, textarea'))
        .filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.height > 0 && rect.width > 0;
        });

      // Look for a card/form element containing these
      const forms = Array.from(document.querySelectorAll('form, [role="form"], div[class*="card"], div[class*="Card"]'))
        .filter(el => el.querySelectorAll('input, textarea').length > 0);

      if (forms.length > 0) {
        const form = forms[0];
        const rect = form.getBoundingClientRect();
        return {
          found: true,
          editorCount: editors.length,
          formWidth: Math.round(rect.width),
          formHeight: Math.round(rect.height),
          positionTop: Math.round(rect.top),
          msg: 'Editor card appeared'
        };
      }

      return {
        found: editors.length > 0,
        editorCount: editors.length,
        msg: editors.length > 0 ? 'Inputs visible but no card container found' : 'No editor inputs found'
      };
    });
    reports.push(`Layout Check 2: ${JSON.stringify(layout2)}`);

    // Step 6: Find and click Edit button on existing recipient
    console.log('Looking for Edit button on recipient row...');
    const editBtnClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const editBtn = buttons.find(btn => {
        const label = btn.getAttribute('aria-label') || '';
        const text = btn.textContent || '';
        return label.toLowerCase().includes('edit') ||
               (text.toLowerCase().includes('edit') && text.length < 50);
      });
      if (editBtn) {
        editBtn.click();
        return true;
      }
      return false;
    });

    if (!editBtnClicked) {
      console.log('WARNING: Edit button not found, but continuing...');
      reports.push('⚠ Edit button not found, skipping edit interaction');
    } else {
      reports.push('✓ Clicked Edit button');

      // Wait for expansion
      await new Promise(resolve => setTimeout(resolve, 800));
      reports.push('✓ Waited 800ms for editor expansion');
    }

    // Step 7: Screenshot 3 - After editing
    console.log('Taking screenshot 3 (editing)...');
    const screenshotPath3 = path.join(SCREENSHOT_DIR, 'notif-3-editing.png');
    await page.screenshot({ path: screenshotPath3, fullPage: true });
    reports.push(`✓ Screenshot saved: notif-3-editing.png`);

    // Check editor card width and field widths
    const layout3 = await page.evaluate(() => {
      const editors = Array.from(document.querySelectorAll('input, textarea'))
        .filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.height > 0 && rect.width > 0;
        });

      if (editors.length === 0) {
        return { found: false, msg: 'No editor inputs visible' };
      }

      const fieldIssues = [];
      const fieldWidths = [];

      editors.slice(0, 5).forEach((input, idx) => {
        const inputRect = input.getBoundingClientRect();
        const scrollWidth = input.scrollWidth;
        const offsetWidth = input.offsetWidth;
        const width = Math.round(inputRect.width);

        fieldWidths.push(width);

        if (scrollWidth > offsetWidth + 5) {
          fieldIssues.push(`Field ${idx}: overflow (scroll:${scrollWidth} > offset:${offsetWidth})`);
        }
        if (width < 80) {
          fieldIssues.push(`Field ${idx}: very narrow (${width}px)`);
        }
      });

      return {
        found: true,
        fieldCount: editors.length,
        fieldWidths: fieldWidths,
        fieldIssues: fieldIssues.length > 0 ? fieldIssues : 'none'
      };
    });
    reports.push(`Layout Check 3: ${JSON.stringify(layout3)}`);

    // Take final measurements
    const measurements = await page.evaluate(() => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const hasHorizontalScroll = document.documentElement.scrollWidth > window.innerWidth;
      const hasVerticalScroll = document.documentElement.scrollHeight > window.innerHeight;

      return {
        viewport,
        hasHorizontalScroll,
        hasVerticalScroll,
        docWidth: document.documentElement.scrollWidth,
        docHeight: document.documentElement.scrollHeight
      };
    });
    reports.push(`Page Measurements: ${JSON.stringify(measurements)}`);

    // Final summary
    reports.push('\n=== SUMMARY ===');
    reports.push('All screenshots captured successfully.');
    reports.push(`View in: ${SCREENSHOT_DIR}`);

  } catch (error) {
    reports.push(`\n!!! ERROR: ${error.message}`);
    // Still capture screenshot if possible
    try {
      const errorPath = path.join(SCREENSHOT_DIR, 'error-state.png');
      await page.screenshot({ path: errorPath, fullPage: true });
      reports.push(`Error screenshot saved: error-state.png`);
    } catch (e) {
      reports.push(`Could not capture error screenshot: ${e.message}`);
    }
  } finally {
    await browser.close();
  }

  // Print report
  console.log('\n' + reports.join('\n'));

  // Also write to a text file in the scratchpad
  const reportPath = path.join(SCREENSHOT_DIR, 'report.txt');
  fs.writeFileSync(reportPath, reports.join('\n'), 'utf8');
  console.log(`\nReport saved to: ${reportPath}`);
}

run().catch(console.error);
