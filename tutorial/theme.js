/* Theme: follow the OS until the user toggles; remember the override. */
(function () {
  const KEY = 'tutorial-theme';
  const COURSE = [
    ['00-setup.html', 'Setup'],
    ['01-big-picture.html', 'Big picture'],
    ['02-cordis.html', 'Cordis'],
    ['03-harness.html', 'Harness'],
    ['04-lab.html', 'Lab'],
    ['05-creator-mode.html', 'Creator mode'],
    ['06-preset.html', 'Preset'],
    ['07-brain.html', 'Brain'],
    ['08-schedule.html', 'Time'],
    ['09-delegation.html', 'Workers'],
    ['10-loop.html', 'Loop'],
    ['11-ui.html', 'UI'],
    ['12-acceptance.html', 'Acceptance'],
    ['13-extensions.html', 'Extensions'],
    ['14-troubleshooting.html', 'Troubleshooting'],
  ];
  const GRADERS = {
    '00-setup.html': ['doctor', 'Check grader setup'],
    '04-lab.html': ['m0', 'Run milestone 0 grader'],
    '06-preset.html': ['m1', 'Run milestone 1 grader'],
    '07-brain.html': ['m2', 'Run milestone 2 grader'],
    '08-schedule.html': ['m3', 'Run milestone 3 grader'],
    '09-delegation.html': ['m4', 'Run milestone 4 grader'],
    '10-loop.html': ['m5', 'Run milestone 5 grader'],
    '11-ui.html': ['m6', 'Run milestone 6 grader'],
    '12-acceptance.html': ['m7', 'Run acceptance grader'],
    'index.html': ['all', 'Grade milestones 0–6'],
  };

  function systemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || systemTheme();
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
    const btn = document.querySelector('.theme-toggle');
    if (btn) syncButton(btn, theme);
  }

  function syncButton(btn, theme) {
    const dark = theme === 'dark';
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.title = dark ? 'Light mode' : 'Dark mode';
    btn.innerHTML = dark
      ? '<span aria-hidden="true">☀</span> Light'
      : '<span aria-hidden="true">☾</span> Dark';
  }

  apply(localStorage.getItem(KEY) || systemTheme());

  function mount() {
    const nav = document.querySelector('nav.top');
    if (!nav) return;
    if (!nav.querySelector('.theme-toggle')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-toggle';
      syncButton(btn, currentTheme());
      btn.addEventListener('click', function () {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        localStorage.setItem(KEY, next);
        apply(next);
      });
      nav.appendChild(btn);
    }
    mountProgress(nav);
    mountGrader();
  }

  function pageName() {
    return window.location.pathname.split('/').pop() || 'index.html';
  }

  function mountProgress(nav) {
    if (document.querySelector('.course-progress')) return;
    const page = pageName();
    const current = COURSE.findIndex(function (entry) { return entry[0] === page; });
    if (current >= 0) {
      localStorage.setItem('tutorial-last-step', String(current));
      localStorage.setItem('tutorial-visited-' + current, '1');
    }
    const storedStep = localStorage.getItem('tutorial-last-step');
    const remembered = storedStep === null ? -1 : Number(storedStep);
    const position = current >= 0 ? current :
      (Number.isInteger(remembered) && remembered >= 0 && remembered < COURSE.length ? remembered : -1);
    const completed = position + 1;

    const wrap = document.createElement('div');
    wrap.className = 'course-progress';
    const copy = document.createElement('div');
    copy.className = 'course-progress-copy';
    const label = document.createElement('span');
    label.textContent = page === 'index.html' ? 'Course map' : 'Course progress';
    const value = document.createElement('strong');
    value.textContent = position >= 0
      ? 'Step ' + (position + 1) + ' of ' + COURSE.length + ' · ' + COURSE[position][1]
      : 'Not started · ' + COURSE.length + ' steps';
    copy.append(label, value);

    const track = document.createElement('div');
    track.className = 'course-progress-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', 'Current tutorial position');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(COURSE.length));
    track.setAttribute('aria-valuenow', String(Math.max(0, completed)));
    const fill = document.createElement('span');
    fill.style.width = (Math.max(0, completed) / COURSE.length * 100) + '%';
    track.appendChild(fill);

    const steps = document.createElement('div');
    steps.className = 'course-progress-steps';
    COURSE.forEach(function (entry, index) {
      const link = document.createElement('a');
      link.href = entry[0];
      link.title = 'Step ' + (index + 1) + ': ' + entry[1];
      link.setAttribute('aria-label', link.title);
      if (index === current) link.classList.add('current');
      if (localStorage.getItem('tutorial-visited-' + index)) link.classList.add('visited');
      const milestone = milestoneForStep(index);
      if (milestone !== undefined && localStorage.getItem('tutorial-grade-m' + milestone) === 'pass') {
        link.classList.add('passed');
      }
      steps.appendChild(link);
    });
    wrap.append(copy, track, steps);
    nav.insertAdjacentElement('afterend', wrap);
  }

  function milestoneForStep(index) {
    return { 4: 0, 6: 1, 7: 2, 8: 3, 9: 4, 10: 5, 11: 6, 12: 7 }[index];
  }

  function mountGrader() {
    const page = pageName();
    const config = GRADERS[page];
    if (!config || document.querySelector('.web-grader')) return;
    const target = config[0];
    const panel = document.createElement('div');
    panel.className = 'web-grader';
    panel.innerHTML = '<div class="web-grader-heading">'
      + '<span>Built-in course grader</span>'
      + '<small>Runs locally and reads your DSH files; it never changes them.</small>'
      + '</div>';

    let workspace;
    if (target !== 'doctor') {
      const field = document.createElement('label');
      field.className = 'web-grader-workspace';
      field.textContent = 'Workspace override (optional)';
      workspace = document.createElement('input');
      workspace.type = 'text';
      workspace.placeholder = target === 'm7' ? '$HOME/agi-acceptance' : '$HOME/agi-lab';
      workspace.autocomplete = 'off';
      field.appendChild(workspace);
      panel.appendChild(field);
    }

    const actions = document.createElement('div');
    actions.className = 'web-grader-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'grade-button';
    button.textContent = config[1];
    const status = document.createElement('span');
    status.className = 'grade-status';
    status.setAttribute('aria-live', 'polite');
    actions.append(button, status);
    const output = document.createElement('pre');
    output.className = 'grade-output';
    output.hidden = true;
    panel.append(actions, output);

    button.addEventListener('click', async function () {
      button.disabled = true;
      status.className = 'grade-status running';
      status.textContent = 'Running…';
      output.hidden = true;
      try {
        const body = { target: target };
        if (workspace && workspace.value.trim()) body.workspace = workspace.value.trim();
        const response = await fetch('/api/grade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok && !result.output) throw new Error(result.error || 'grader request failed');
        output.textContent = result.output || result.error || 'No grader output.';
        output.hidden = false;
        status.className = 'grade-status ' + (result.ok ? 'passed' : 'failed');
        status.textContent = result.ok ? 'Passed' : 'Needs work';
        if (target.match(/^m[0-7]$/)) {
          localStorage.setItem('tutorial-grade-' + target, result.ok ? 'pass' : 'fail');
          if (result.ok) {
            const current = COURSE.findIndex(function (entry) { return entry[0] === page; });
            const dots = document.querySelectorAll('.course-progress-steps a');
            if (dots[current]) dots[current].classList.add('passed');
          }
        }
      } catch (error) {
        status.className = 'grade-status failed';
        status.textContent = 'Unavailable';
        output.textContent = 'Start this course with ./setup-tutorial.sh, then use the URL it prints.\n\n'
          + String(error);
        output.hidden = false;
      } finally {
        button.disabled = false;
      }
    });

    const boxes = document.querySelectorAll('.box.test');
    if (boxes.length) boxes[boxes.length - 1].appendChild(panel);
    else {
      const pager = document.querySelector('nav.pager');
      (pager || document.querySelector('main')).insertAdjacentElement(pager ? 'beforebegin' : 'beforeend', panel);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
    if (localStorage.getItem(KEY)) return;
    apply(e.matches ? 'dark' : 'light');
  });
})();
