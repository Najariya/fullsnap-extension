// FullSnap Annotation Engine
// Provides draw, arrow, text, highlight, and blur tools on a transparent canvas overlay

class AnnotationEngine {
  constructor(annotationCanvas, screenshotCanvas) {
    this.canvas = annotationCanvas; // Dynamic layer (preview)
    this.screenshotCanvas = screenshotCanvas;
    this.ctx = annotationCanvas.getContext('2d');

    // Remove any previously inserted static canvas (from prior AnnotationEngine instances)
    const wrapper = annotationCanvas.parentElement;
    const oldStatic = wrapper.querySelector('.annotation-static-canvas');
    if (oldStatic) {
      oldStatic.remove();
    }

    // Remove any leftover text input containers
    wrapper.querySelectorAll('.text-input-container').forEach((el) => el.remove());

    // Create static layer for completed annotations
    this.staticCanvas = document.createElement('canvas');
    this.staticCanvas.className = 'annotation-static-canvas';
    this.staticCanvas.width = annotationCanvas.width;
    this.staticCanvas.height = annotationCanvas.height;
    this.staticCanvas.style.position = 'absolute';
    this.staticCanvas.style.top = '0';
    this.staticCanvas.style.left = '0';
    this.staticCanvas.style.width = '100%';
    this.staticCanvas.style.height = '100%';
    this.staticCanvas.style.pointerEvents = 'none';
    this.staticCtx = this.staticCanvas.getContext('2d');

    // Insert static canvas between screenshot and annotation canvas
    wrapper.insertBefore(this.staticCanvas, annotationCanvas);

    this.actions = [];
    this.redoStack = [];
    this.currentTool = null;
    this.color = '#FF3B30';
    this.strokeWidth = 3;
    this.isDrawing = false;
    this.currentPath = [];
    this.startPoint = null;
    this.textInput = null;
    this.rafPending = false;
    this.lastPreviewPoint = null;

    // Remove old listeners if any (safety for re-creation)
    this.canvas.removeEventListener('mousedown', this.canvas._annotMouseDown);

    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp   = this._onMouseUp.bind(this);

    // Only mousedown is permanently on the canvas.
    // mousemove and mouseup are attached to *window* dynamically in _onMouseDown and
    // removed in _onMouseUp, so fast strokes that exit the canvas boundary are never
    // silently dropped (the old canvas-scoped listeners stopped tracking mid-stroke).
    this.canvas.addEventListener('mousedown', this._onMouseDown);

    // Store reference for cleanup in destroy()
    this.canvas._annotMouseDown = this._onMouseDown;
  }

  destroy() {
    // Remove the canvas mousedown listener
    this.canvas.removeEventListener('mousedown', this._onMouseDown);

    // Remove window-level listeners in case destroy() is called mid-stroke
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);

    if (this.staticCanvas && this.staticCanvas.parentElement) {
      this.staticCanvas.remove();
    }

    if (this.textInput) {
      this._cancelTextInput();
    }
  }

  setTool(tool) {
    this.currentTool = tool;
    this._finishTextInput();
    this.isDrawing = false;
    this.currentPath = [];
    this.startPoint = null;

    // pointer-events is controlled exclusively by the CSS class system:
    //   .canvas-wrapper.annotation-active #annotation-canvas { pointer-events: auto !important }
    // toggled by viewer.js via wrapper.classList.add/remove('annotation-active').
    // Setting inline style.pointerEvents here would conflict with the !important CSS rule
    // depending on browser evaluation order, so we only set the cursor as a UX hint.
    if (tool) {
      this.canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
    } else {
      this.canvas.style.cursor = 'default';
    }
  }

  setColor(color) {
    this.color = color;
  }

  setStrokeWidth(width) {
    this.strokeWidth = width;
  }

  // --- Mouse handlers ---

  _getCanvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  _onMouseDown(e) {
    if (!this.currentTool || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const point = this._getCanvasPoint(e);

    switch (this.currentTool) {
      case 'draw':
      case 'highlight':
        this.isDrawing = true;
        this.currentPath = [point];
        break;
      case 'arrow':
      case 'blur':
        this.isDrawing = true;
        this.startPoint = point;
        break;
      case 'text':
        this._createTextInput(point, e);
        return; // text tool uses its own input; no window tracking needed
    }

    // Attach move/up to *window* so fast strokes that exit the canvas boundary
    // are still tracked correctly (the old canvas-scoped listeners would drop them).
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
  }

  _onMouseMove(e) {
    if (!this.isDrawing || !this.currentTool) return;
    e.preventDefault();
    e.stopPropagation();

    const point = this._getCanvasPoint(e);

    switch (this.currentTool) {
      case 'draw':
      case 'highlight': {
        // Only add points if 2+ pixels apart (reduce noise)
        const lastPt = this.currentPath[this.currentPath.length - 1];
        if (lastPt) {
          const dx = point.x - lastPt.x;
          const dy = point.y - lastPt.y;
          if (Math.sqrt(dx * dx + dy * dy) >= 2) {
            this.currentPath.push(point);
          }
        } else {
          this.currentPath.push(point);
        }
        break;
      }
      case 'arrow':
      case 'blur':
        this.lastPreviewPoint = point;
        break;
    }

    // Throttle preview rendering using RAF
    if (!this.rafPending) {
      this.rafPending = true;
      requestAnimationFrame(() => {
        this._drawPreviewOnly();
        this.rafPending = false;
      });
    }
  }

  _onMouseUp(e) {
    // Always remove window listeners first — even if we bail out early below,
    // we must not leave dangling global listeners.
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);

    if (!this.isDrawing || !this.currentTool) return;
    e.preventDefault();
    e.stopPropagation();

    const point = this._getCanvasPoint(e);

    switch (this.currentTool) {
      case 'draw':
        if (this.currentPath.length > 1) {
          this.actions.push({
            tool: 'draw',
            path: [...this.currentPath],
            color: this.color,
            strokeWidth: this.strokeWidth,
          });
          this.redoStack = [];
          this._renderToStatic(this.actions[this.actions.length - 1]);
        }
        break;

      case 'highlight':
        if (this.currentPath.length > 1) {
          this.actions.push({
            tool: 'highlight',
            path: [...this.currentPath],
            color: this.color,
            strokeWidth: this.strokeWidth * 6,
          });
          this.redoStack = [];
          this._renderToStatic(this.actions[this.actions.length - 1]);
        }
        break;

      case 'arrow':
        if (this.startPoint) {
          const dx = point.x - this.startPoint.x;
          const dy = point.y - this.startPoint.y;
          if (Math.sqrt(dx * dx + dy * dy) > 5) {
            this.actions.push({
              tool: 'arrow',
              start: { ...this.startPoint },
              end: { ...point },
              color: this.color,
              strokeWidth: this.strokeWidth,
            });
            this.redoStack = [];
            this._renderToStatic(this.actions[this.actions.length - 1]);
          }
        }
        break;

      case 'blur':
        if (this.startPoint) {
          const dx = point.x - this.startPoint.x;
          const dy = point.y - this.startPoint.y;
          if (Math.sqrt(dx * dx + dy * dy) > 5) {
            this.actions.push({
              tool: 'blur',
              start: { ...this.startPoint },
              end: { ...point },
              intensity: 15,
            });
            this.redoStack = [];
            this._renderToStatic(this.actions[this.actions.length - 1]);
          }
        }
        break;
    }

    this.isDrawing = false;
    this.currentPath = [];
    this.startPoint = null;
    this.lastPreviewPoint = null;

    // Clear preview canvas after committing to static
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // --- Text input ---

  _createTextInput(point, mouseEvent) {
    this._finishTextInput();

    const rect = this.canvas.getBoundingClientRect();
    const wrapper = this.canvas.parentElement;

    // Position in CSS pixels relative to the wrapper.
    // The wrapper is transformed by zoom, but elements inside are in wrapper-local coords.
    // rect gives us the visual (post-transform) size. We need to map canvas coords
    // back to wrapper-local CSS coords (pre-zoom).
    const cssX = (point.x / this.canvas.width) * (this.canvas.width);   // canvas pixel x
    const cssY = (point.y / this.canvas.height) * (this.canvas.height);  // canvas pixel y
    // But the wrapper's CSS dimensions = canvas width/height (since canvas has display:block)
    // and the wrapper is scaled by zoom. The text container is inside wrapper, so coords
    // should be in the wrapper's local coordinate system = canvas pixel coordinates.

    const container = document.createElement('div');
    container.className = 'text-input-container';
    // Use canvas pixel coordinates directly since the container is inside the scaled wrapper
    container.style.left = point.x + 'px';
    container.style.top = point.y + 'px';
    // Counter-scale the text input so it appears at a readable size despite the zoom transform
    container.style.transformOrigin = 'top left';

    const fontSize = this.strokeWidth * 5 + 8;

    const textarea = document.createElement('textarea');
    textarea.style.color = this.color;
    textarea.style.fontSize = fontSize + 'px';
    textarea.rows = 1;
    textarea.placeholder = 'Type text...';
    container.appendChild(textarea);

    wrapper.appendChild(container);
    textarea.focus();

    this.textInput = {
      container,
      textarea,
      point: { x: point.x, y: point.y },
      color: this.color,
      fontSize,
    };

    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Prevent viewer keyboard shortcuts from firing
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._finishTextInput();
      }
      if (e.key === 'Escape') {
        this._cancelTextInput();
      }
    });

    textarea.addEventListener('blur', () => {
      setTimeout(() => {
        if (this.textInput) {
          this._finishTextInput();
        }
      }, 150);
    });
  }

  _finishTextInput() {
    if (!this.textInput) return;

    const text = this.textInput.textarea.value.trim();
    if (text) {
      const action = {
        tool: 'text',
        text,
        position: { ...this.textInput.point },
        color: this.textInput.color,
        fontSize: this.textInput.fontSize,
      };
      this.actions.push(action);
      this.redoStack = [];
      this._renderToStatic(action);
    }

    this.textInput.container.remove();
    this.textInput = null;
  }

  _cancelTextInput() {
    if (!this.textInput) return;
    this.textInput.container.remove();
    this.textInput = null;
  }

  // --- Drawing ---

  redraw() {
    // Clear and redraw static canvas with all completed annotations
    this.staticCtx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    for (const action of this.actions) {
      this._renderActionTo(this.staticCtx, action);
    }

    // Clear dynamic canvas
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _drawPreviewOnly() {
    // Clear ONLY the dynamic canvas (not static layer)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw ONLY the current in-progress preview
    switch (this.currentTool) {
      case 'draw':
        if (this.currentPath.length > 1) {
          this._renderDrawTo(this.ctx, this.currentPath, this.color, this.strokeWidth);
        }
        break;
      case 'highlight':
        if (this.currentPath.length > 1) {
          this._renderHighlightTo(this.ctx, this.currentPath, this.color, this.strokeWidth * 6);
        }
        break;
      case 'arrow':
        if (this.startPoint && this.lastPreviewPoint) {
          this._renderArrowTo(this.ctx, this.startPoint, this.lastPreviewPoint, this.color, this.strokeWidth);
        }
        break;
      case 'blur':
        if (this.startPoint && this.lastPreviewPoint) {
          this._renderBlurPreview(this.ctx, this.startPoint, this.lastPreviewPoint);
        }
        break;
    }
  }

  _renderToStatic(action) {
    this._renderActionTo(this.staticCtx, action);
  }

  _renderActionTo(targetCtx, action) {
    switch (action.tool) {
      case 'draw':
        this._renderDrawTo(targetCtx, action.path, action.color, action.strokeWidth);
        break;
      case 'highlight':
        this._renderHighlightTo(targetCtx, action.path, action.color, action.strokeWidth);
        break;
      case 'arrow':
        this._renderArrowTo(targetCtx, action.start, action.end, action.color, action.strokeWidth);
        break;
      case 'text':
        this._renderTextTo(targetCtx, action.text, action.position, action.color, action.fontSize);
        break;
      case 'blur':
        this._renderBlurTo(targetCtx, action.start, action.end, action.intensity);
        break;
    }
  }

  _renderDrawTo(targetCtx, path, color, strokeWidth) {
    if (path.length < 2) return;
    targetCtx.save();
    targetCtx.strokeStyle = color;
    targetCtx.lineWidth = strokeWidth;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    targetCtx.beginPath();
    targetCtx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) {
      targetCtx.lineTo(path[i].x, path[i].y);
    }
    targetCtx.stroke();
    targetCtx.restore();
  }

  _renderHighlightTo(targetCtx, path, color, strokeWidth) {
    if (path.length < 2) return;
    targetCtx.save();
    targetCtx.globalAlpha = 0.35;
    targetCtx.strokeStyle = color;
    targetCtx.lineWidth = strokeWidth;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    targetCtx.beginPath();
    targetCtx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) {
      targetCtx.lineTo(path[i].x, path[i].y);
    }
    targetCtx.stroke();
    targetCtx.restore();
  }

  _renderArrowTo(targetCtx, start, end, color, strokeWidth) {
    targetCtx.save();
    targetCtx.strokeStyle = color;
    targetCtx.fillStyle = color;
    targetCtx.lineWidth = strokeWidth;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';

    // Draw line
    targetCtx.beginPath();
    targetCtx.moveTo(start.x, start.y);
    targetCtx.lineTo(end.x, end.y);
    targetCtx.stroke();

    // Draw arrowhead
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const headLength = strokeWidth * 5;
    const headAngle = Math.PI / 6;

    targetCtx.beginPath();
    targetCtx.moveTo(end.x, end.y);
    targetCtx.lineTo(
      end.x - headLength * Math.cos(angle - headAngle),
      end.y - headLength * Math.sin(angle - headAngle)
    );
    targetCtx.lineTo(
      end.x - headLength * Math.cos(angle + headAngle),
      end.y - headLength * Math.sin(angle + headAngle)
    );
    targetCtx.closePath();
    targetCtx.fill();

    targetCtx.restore();
  }

  _renderTextTo(targetCtx, text, position, color, fontSize) {
    targetCtx.save();
    targetCtx.fillStyle = color;
    targetCtx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    targetCtx.textBaseline = 'top';

    const lines = text.split('\n');
    const lineHeight = fontSize * 1.3;
    for (let i = 0; i < lines.length; i++) {
      targetCtx.fillText(lines[i], position.x, position.y + i * lineHeight);
    }

    targetCtx.restore();
  }

  // --- Undo/Redo ---

  undo() {
    if (this.actions.length === 0) return;
    this.redoStack.push(this.actions.pop());
    this.redraw();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    this.actions.push(this.redoStack.pop());
    this.redraw();
  }

  clearAll() {
    if (this.actions.length === 0) return;
    this.redoStack = [];
    this.actions = [];
    this.redraw();
  }

  hasAnnotations() {
    return this.actions.length > 0;
  }

  // --- Blur Tool ---

  _renderBlurPreview(targetCtx, start, end) {
    targetCtx.save();
    targetCtx.strokeStyle = '#000000';
    targetCtx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    targetCtx.lineWidth = 2;
    targetCtx.setLineDash([6, 4]);

    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);

    targetCtx.fillRect(x, y, w, h);
    targetCtx.strokeRect(x, y, w, h);
    targetCtx.restore();
  }

  _renderBlurTo(targetCtx, start, end, intensity) {
    const x = Math.round(Math.min(start.x, end.x));
    const y = Math.round(Math.min(start.y, end.y));
    const w = Math.round(Math.abs(end.x - start.x));
    const h = Math.round(Math.abs(end.y - start.y));

    if (w < 5 || h < 5) return;

    // Clamp to canvas bounds
    const cx = Math.max(0, x);
    const cy = Math.max(0, y);
    const cw = Math.min(w, this.screenshotCanvas.width - cx);
    const ch = Math.min(h, this.screenshotCanvas.height - cy);

    if (cw <= 0 || ch <= 0) return;

    // Get image data from screenshot canvas
    const screenshotCtx = this.screenshotCanvas.getContext('2d');
    const imageData = screenshotCtx.getImageData(cx, cy, cw, ch);

    // Apply box blur
    this._boxBlur(imageData, intensity);

    // Draw blurred region onto the target context
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = cw;
    tempCanvas.height = ch;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.putImageData(imageData, 0, 0);

    targetCtx.drawImage(tempCanvas, cx, cy);
  }

  _boxBlur(imageData, radius) {
    const pixels = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    // Horizontal pass
    const tempPixels = new Uint8ClampedArray(pixels);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0,
          g = 0,
          b = 0,
          a = 0,
          count = 0;

        for (let kx = -radius; kx <= radius; kx++) {
          const px = x + kx;
          if (px >= 0 && px < width) {
            const idx = (y * width + px) * 4;
            r += tempPixels[idx];
            g += tempPixels[idx + 1];
            b += tempPixels[idx + 2];
            a += tempPixels[idx + 3];
            count++;
          }
        }

        const idx = (y * width + x) * 4;
        pixels[idx] = r / count;
        pixels[idx + 1] = g / count;
        pixels[idx + 2] = b / count;
        pixels[idx + 3] = a / count;
      }
    }

    // Vertical pass
    tempPixels.set(pixels);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0,
          g = 0,
          b = 0,
          a = 0,
          count = 0;

        for (let ky = -radius; ky <= radius; ky++) {
          const py = y + ky;
          if (py >= 0 && py < height) {
            const idx = (py * width + x) * 4;
            r += tempPixels[idx];
            g += tempPixels[idx + 1];
            b += tempPixels[idx + 2];
            a += tempPixels[idx + 3];
            count++;
          }
        }

        const idx = (y * width + x) * 4;
        pixels[idx] = r / count;
        pixels[idx + 1] = g / count;
        pixels[idx + 2] = b / count;
        pixels[idx + 3] = a / count;
      }
    }
  }
}
