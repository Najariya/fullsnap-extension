// FullSnap Content Script - Scroll engine
// Injected on-demand into the active tab to measure page, scroll, and manage sticky elements

(function () {
  // Prevent double-injection
  if (window.__fullsnap_injected) return;
  window.__fullsnap_injected = true;

  let fixedElements = [];
  let originalScrollX = 0;
  let originalScrollY = 0;
  let scrollbarStyle = null;

  // Listen for messages from service worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case MSG.START_CAPTURE:
        handleStartCapture(sendResponse);
        return true;

      case MSG.SCROLL_TO:
        handleScrollTo(message, sendResponse);
        return true;

      case MSG.CLEANUP:
        handleCleanup(sendResponse);
        return true;
    }
  });

  function handleStartCapture(sendResponse) {
    try {
      // Save original scroll position
      originalScrollX = window.scrollX;
      originalScrollY = window.scrollY;

      // Measure page
      const body = document.body;
      const html = document.documentElement;
      const totalHeight = Math.max(
        body.scrollHeight || 0,
        html.scrollHeight || 0,
        body.offsetHeight || 0,
        html.offsetHeight || 0
      );
      const totalWidth = Math.max(
        body.scrollWidth || 0,
        html.scrollWidth || 0,
        body.offsetWidth || 0,
        html.offsetWidth || 0
      );

      // Find fixed/sticky elements
      fixedElements = findFixedElements();

      // Hide scrollbar
      hideScrollbar();

      sendResponse({
        totalHeight,
        totalWidth,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  function handleScrollTo(message, sendResponse) {
    try {
      const { scrollY, isFirst, isLast, progress } = message;

      // For first frame, ensure we're at true top of page
      if (isFirst && scrollY === 0) {
        // Force scroll to absolute top
        window.scrollTo({
          left: 0,
          top: 0,
          behavior: 'instant',
        });
        // Double-check we're at top
        if (window.scrollY !== 0) {
          console.warn('[FullSnap] First frame not at top, scrollY:', window.scrollY);
          window.scroll(0, 0); // Fallback
        }
      } else {
        // Normal scroll for other frames
        window.scrollTo({
          left: 0,
          top: scrollY,
          behavior: 'instant',
        });
      }

      // CRITICAL FIX: Hide fixed elements on ALL frames including first
      // Showing them on first frame causes viewport offset issues
      hideFixedElements();

      // Wait for paint to settle
      // Use double RAF for first frame to ensure complete render
      const rafDelay = isFirst ? 2 : 1;
      let rafCount = 0;
      function waitForRender() {
        rafCount++;
        if (rafCount < rafDelay) {
          requestAnimationFrame(waitForRender);
        } else {
          setTimeout(() => {
            sendResponse({ ok: true, scrollY: window.scrollY });
          }, 0);
        }
      }
      requestAnimationFrame(waitForRender);
    } catch (err) {
      sendResponse({ error: err.message });
    }
    return true;
  }

  function handleCleanup(sendResponse) {
    // Restore fixed elements
    restoreFixedElements();

    // Restore scroll position
    window.scrollTo({
      left: originalScrollX,
      top: originalScrollY,
      behavior: 'instant',
    });

    // Remove scrollbar hiding
    restoreScrollbar();

    // Clean up injection flag
    delete window.__fullsnap_injected;

    sendResponse({ ok: true });
  }

  // --- Fixed/Sticky element management ---

  function findFixedElements() {
    const elements = [];

    // Optimized: Target fixed/sticky elements directly instead of scanning entire DOM
    // This is much faster than querySelectorAll('*') on large pages
    const fixedSelectors = [
      '[style*="position: fixed"]',
      '[style*="position:fixed"]',
      '[style*="position: sticky"]',
      '[style*="position:sticky"]',
      '.fixed',
      '.sticky',
      '.navbar-fixed',
      '.header-fixed'
    ].join(',');

    try {
      const candidates = document.querySelectorAll(fixedSelectors);
      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'sticky') {
          elements.push({
            element: el,
            originalVisibility: el.style.visibility,
            originalDisplay: el.style.display,
            originalOpacity: el.style.opacity,
            originalZIndex: el.style.zIndex,
          });
        }
      }
    } catch (e) {
      // Fallback to checking all elements if selector fails
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'sticky') {
          elements.push({
            element: el,
            originalVisibility: el.style.visibility,
            originalDisplay: el.style.display,
            originalOpacity: el.style.opacity,
            originalZIndex: el.style.zIndex,
          });
        }
      }
    }

    return elements;
  }

  function hideFixedElements() {
    for (const item of fixedElements) {
      item.element.style.setProperty('visibility', 'hidden', 'important');
    }
  }

  function restoreFixedElements() {
    for (const item of fixedElements) {
      // Restore all saved properties
      if (item.originalVisibility) {
        item.element.style.visibility = item.originalVisibility;
      } else {
        item.element.style.removeProperty('visibility');
      }

      if (item.originalDisplay) {
        item.element.style.display = item.originalDisplay;
      } else if (item.element.style.display) {
        item.element.style.removeProperty('display');
      }

      if (item.originalOpacity) {
        item.element.style.opacity = item.originalOpacity;
      } else if (item.element.style.opacity) {
        item.element.style.removeProperty('opacity');
      }
    }
  }

  // --- Scrollbar management ---

  function hideScrollbar() {
    scrollbarStyle = document.createElement('style');
    scrollbarStyle.id = 'fullsnap-hide-scrollbar';
    scrollbarStyle.textContent = `
      html::-webkit-scrollbar { display: none !important; }
      html { scrollbar-width: none !important; -ms-overflow-style: none !important; }
    `;
    document.head.appendChild(scrollbarStyle);
  }

  function restoreScrollbar() {
    if (scrollbarStyle && scrollbarStyle.parentNode) {
      scrollbarStyle.parentNode.removeChild(scrollbarStyle);
      scrollbarStyle = null;
    }
  }

})();
