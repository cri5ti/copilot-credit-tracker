// @ts-check
(function () {
    // @ts-ignore acquireVsCodeApi is provided by the webview host.
    const vscode = acquireVsCodeApi();

    const summary = /** @type {HTMLElement} */ (document.getElementById('summary'));
    const charts = /** @type {HTMLElement} */ (document.getElementById('charts'));
    const form = /** @type {HTMLFormElement} */ (document.getElementById('plan-form'));
    const planNote = /** @type {HTMLElement} */ (document.getElementById('plan-note'));
    const tooltip = /** @type {HTMLElement} */ (document.getElementById('tooltip'));
    const popup = /** @type {HTMLElement} */ (document.getElementById('day-popup'));
    const popupTitle = /** @type {HTMLElement} */ (document.getElementById('day-popup-title'));
    const popupOn = /** @type {HTMLInputElement} */ (document.getElementById('day-popup-on'));
    const popupWeight = /** @type {HTMLInputElement} */ (document.getElementById('day-popup-weight'));
    const popupValue = /** @type {HTMLElement} */ (document.getElementById('day-popup-value'));

    const fromInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('from'));
    const toInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('to'));
    const budgetInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('budget'));

    /** @type {{ plan: { from: string, to: string, budget: number, isDefault: boolean }, month: { first: string, last: string }, remaining: number } | undefined} */
    let state;
    // Selected days survive re-renders; the anchor is where a drag or shift-click started.
    /** @type {string[]} */
    let selection = [];
    /** @type {string | undefined} */
    let anchor;
    let dragging = false;
    let formDirty = false;

    // ---- Toolbar -------------------------------------------------------------

    const menuButton = /** @type {HTMLButtonElement} */ (document.getElementById('menu-button'));
    const menuList = /** @type {HTMLElement} */ (document.getElementById('menu-list'));

    /** @param {boolean} open */
    function setMenuOpen(open) {
        menuList.hidden = !open;
        menuButton.setAttribute('aria-expanded', String(open));
    }

    menuButton.addEventListener('click', () => {
        const open = menuList.hidden;
        setMenuOpen(open);
        if (open) {
            /** @type {HTMLElement | null} */ (menuList.querySelector('button'))?.focus();
        }
    });

    menuList.querySelectorAll('button').forEach((element) => {
        const button = /** @type {HTMLButtonElement} */ (element);
        button.addEventListener('click', () => {
            const command = button.dataset.command;
            setMenuOpen(false);
            menuButton.focus();
            if (command !== 'showLog') {
                // Dimmed until the next render arrives with the result.
                menuButton.classList.add('busy');
            }
            vscode.postMessage({ command });
        });
    });

    document.addEventListener('pointerdown', (event) => {
        const target = /** @type {Element} */ (event.target);
        if (!menuList.hidden && target instanceof Element && !target.closest('.menu')) {
            setMenuOpen(false);
        }
    });

    function resetToolbar() {
        menuButton.classList.remove('busy');
    }

    // ---- Plan form -----------------------------------------------------------

    function fillForm() {
        if (!state || formDirty) {
            return;
        }
        const { plan, month, remaining } = state;
        for (const input of [fromInput, toInput]) {
            input.min = month.first;
            input.max = month.last;
        }
        fromInput.value = plan.from;
        toInput.value = plan.to;
        budgetInput.value = String(plan.budget);
        planNote.textContent = plan.isDefault
            ? `Whole month with the full limit. "Reset to today" starts fresh from today with the ${Math.round(remaining).toLocaleString('en-US')} credits left.`
            : `Custom plan. "Month defaults" goes back to the whole month and the full limit.`;
    }

    form.addEventListener('input', () => {
        formDirty = true;
    });

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (fromInput.value > toInput.value) {
            planNote.textContent = '"From" must be on or before "To".';
            return;
        }
        formDirty = false;
        vscode.postMessage({ command: 'setPlan', from: fromInput.value, to: toInput.value, budget: Number(budgetInput.value) });
    });

    form.querySelectorAll('[data-plan]').forEach((element) => {
        const button = /** @type {HTMLButtonElement} */ (element);
        button.addEventListener('click', () => {
            formDirty = false;
            vscode.postMessage({ command: button.dataset.plan });
        });
    });

    // ---- Tooltip -------------------------------------------------------------

    document.addEventListener('pointermove', (event) => {
        const target = /** @type {Element} */ (event.target);
        const tipElement = target instanceof Element ? target.closest('[data-tip]') : null;
        if (!tipElement || !popup.hidden) {
            tooltip.hidden = true;
            return;
        }
        // textContent: tips come from rendered data and must never be parsed as HTML.
        tooltip.textContent = tipElement.getAttribute('data-tip') || '';
        tooltip.hidden = false;
        const margin = 14;
        const { width, height } = tooltip.getBoundingClientRect();
        const left = event.clientX + margin + width > window.innerWidth ? event.clientX - margin - width : event.clientX + margin;
        const top = event.clientY + margin + height > window.innerHeight ? event.clientY - margin - height : event.clientY + margin;
        tooltip.style.left = `${Math.max(left, 4)}px`;
        tooltip.style.top = `${Math.max(top, 4)}px`;
    });

    document.addEventListener('pointerleave', () => {
        tooltip.hidden = true;
    });

    // ---- Day selection and the workload popup --------------------------------

    function allDays() {
        return Array.from(charts.querySelectorAll('.month-days [data-day]')).map((element) => element.getAttribute('data-day') || '');
    }

    /** @param {string} a @param {string} b */
    function rangeBetween(a, b) {
        const [from, to] = a <= b ? [a, b] : [b, a];
        return allDays().filter((day) => day >= from && day <= to);
    }

    function paintSelection() {
        charts.querySelectorAll('.month-days [data-day]').forEach((element) => {
            element.classList.toggle('selected', selection.includes(element.getAttribute('data-day') || ''));
        });
    }

    /** @param {string} day */
    function weightOf(day) {
        const element = charts.querySelector(`.month-days [data-day="${day}"]`);
        return element ? Number(element.getAttribute('data-weight')) : 1;
    }

    /** @param {number} percent */
    function showPopupValue(percent) {
        popupWeight.value = String(percent);
        popupOn.checked = percent > 0;
        popupValue.textContent = percent > 0 ? `${percent}%` : 'off';
    }

    /** @param {number} clientX @param {number} clientY */
    function openPopup(clientX, clientY) {
        if (selection.length === 0) {
            return;
        }
        const label = (/** @type {string} */ day) => new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        popupTitle.textContent = selection.length === 1
            ? label(selection[0])
            : `${label(selection[0])} to ${label(selection[selection.length - 1])} (${selection.length} days)`;
        showPopupValue(Math.round(weightOf(selection[0]) * 100));
        tooltip.hidden = true;
        popup.hidden = false;
        const { width, height } = popup.getBoundingClientRect();
        popup.style.left = `${Math.max(Math.min(clientX - width / 2, window.innerWidth - width - 8), 8)}px`;
        popup.style.top = `${clientY + 16 + height > window.innerHeight ? Math.max(clientY - height - 16, 8) : clientY + 16}px`;
    }

    function closePopup() {
        popup.hidden = true;
        selection = [];
        anchor = undefined;
        paintSelection();
    }

    /** @param {number | null} weight */
    function sendWeight(weight) {
        if (selection.length > 0) {
            vscode.postMessage({ command: 'setDayWeights', days: selection, weight });
        }
    }

    charts.addEventListener('pointerdown', (event) => {
        const target = /** @type {Element} */ (event.target);
        const day = target instanceof Element ? target.closest('.month-days [data-day]')?.getAttribute('data-day') : undefined;
        if (!day) {
            return;
        }
        event.preventDefault();
        if (event.shiftKey && anchor) {
            selection = rangeBetween(anchor, day);
        } else {
            anchor = day;
            selection = [day];
        }
        dragging = true;
        popup.hidden = true;
        paintSelection();
    });

    charts.addEventListener('pointerover', (event) => {
        if (!dragging || !anchor) {
            return;
        }
        const target = /** @type {Element} */ (event.target);
        const day = target instanceof Element ? target.closest('.month-days [data-day]')?.getAttribute('data-day') : undefined;
        if (day) {
            selection = rangeBetween(anchor, day);
            paintSelection();
        }
    });

    document.addEventListener('pointerup', (event) => {
        if (!dragging) {
            return;
        }
        dragging = false;
        openPopup(event.clientX, event.clientY);
    });

    popupOn.addEventListener('change', () => {
        const percent = popupOn.checked ? 100 : 0;
        showPopupValue(percent);
        sendWeight(percent / 100);
    });

    popupWeight.addEventListener('input', () => showPopupValue(Number(popupWeight.value)));
    popupWeight.addEventListener('change', () => sendWeight(Number(popupWeight.value) / 100));

    /** @type {HTMLElement} */ (document.getElementById('day-popup-default')).addEventListener('click', () => {
        sendWeight(null);
        closePopup();
    });
    /** @type {HTMLElement} */ (document.getElementById('day-popup-close')).addEventListener('click', closePopup);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !menuList.hidden) {
            setMenuOpen(false);
            menuButton.focus();
        } else if (event.key === 'Escape' && !popup.hidden) {
            closePopup();
        }
    });

    document.addEventListener('pointerdown', (event) => {
        const target = /** @type {Element} */ (event.target);
        if (!popup.hidden && target instanceof Element && !popup.contains(target) && !target.closest('.month-days [data-day]')) {
            closePopup();
        }
    });

    // ---- Rendering -----------------------------------------------------------

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message?.type === 'planError') {
            planNote.textContent = message.message;
            return;
        }
        if (message?.type !== 'render') {
            return;
        }
        summary.innerHTML = message.summary;
        charts.innerHTML = message.charts;
        state = message.state;
        paintSelection();
        fillForm();
        resetToolbar();
    });

    vscode.postMessage({ command: 'ready' });
})();
