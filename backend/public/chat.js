(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var SITE_ID = params.get('siteId') || 'default';
  var TITLE = params.get('title') || 'Sire Printing';
  var ACCENT = params.get('accent') || '#4f46e5';
  var PARENT_ORIGIN = params.get('parentOrigin') || '';
  var AGENT_NAME = params.get('agent') || 'Zack';
  var PAGE_URL = params.get('pageUrl') || '';

  // "/satin-lined-boxes" -> "satin lined boxes"; mirrors productFromUrl() on the server.
  function productFromUrl(url) {
    try {
      var slug = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
      if (slug === 'box-styles' || !/box|packag|carton|mailer|sleeve|tube|bag|label|insert|tray|display/i.test(slug)) return null;
      return decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\bcbd\b/i, 'CBD').trim();
    } catch (e) { return null; }
  }
  var PRODUCT = productFromUrl(PAGE_URL) || 'custom printed boxes';

  // Greeting as separate lines -> separate bubbles, like a live rep typing.
  function greetingFor(name) {
    return (name ? 'Hi ' + name : 'Hi there,Zack This Side') + '\nLooking for ' + PRODUCT + '?\nI am live here to assist you. Lets chat';
  }
  var GREETING = params.get('greeting') || greetingFor('');

  var MUTE_KEY = 'sireprinting:muted';

  var $ = function (id) { return document.getElementById(id); };
  var elRoot = $('pb-root');
  var elMessages = $('pb-messages');
  var elForm = $('pb-form');
  var elText = $('pb-text');
  var elSend = $('pb-send');
  var elMic = $('pb-mic');
  var elCall = $('pb-call');
  var elQuote = $('pb-quote');
  var elClose = $('pb-close');
  var elMute = $('pb-mute');
  var elError = $('pb-error');
  var elAvatar = $('pb-avatar');
  var elRing = document.querySelector('.pb-avatar-ring');
  var elCaption = $('pb-caption');
  var elTitle = $('pb-title');
  var elCallUi = $('pb-call-ui');
  var elCallStatus = $('pb-call-status');
  var elCallLive = $('pb-call-live');
  var elCallMute = $('pb-call-mute');
  var elCallEnd = $('pb-call-end');
  var elLead = $('pb-lead');
  var elLeadForm = $('pb-lead-form');
  var elLeadErr = $('pb-lead-err');
  var elLeadDone = $('pb-lead-done');
  var elLeadSubmit = $('pb-lead-submit');
  var elLeadX = $('pb-lead-x');

  elTitle.textContent = TITLE;
  document.title = TITLE;

  // The agent's photo on a canvas, lip-synced to the voice.
  var head = window.TalkingHead
    ? TalkingHead.create($('pb-avatar-canvas'), '/avatar-csr.jpg')
    : null;

  // ---------- theme ----------
  function darken(hex, amt) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex) ||
      /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(hex);
    if (!m) return hex;
    var parts = m.slice(1).map(function (h) { return h.length === 1 ? h + h : h; });
    var rgb = parts.map(function (h) { return Math.max(0, Math.round(parseInt(h, 16) * (1 - amt))); });
    return 'rgb(' + rgb.join(',') + ')';
  }
  document.documentElement.style.setProperty('--accent', ACCENT);
  document.documentElement.style.setProperty('--accent-dark', darken(ACCENT, 0.28));

  // ---------- state ----------
  // Kept in memory only: every fresh load of the chat starts a new conversation,
  // so the assistant never continues an old chat the visitor can't see on screen.
  var conversationId = null;
  var muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) {}
  document.body.classList.toggle('pb-muted', muted);

  var sending = false;
  var callMode = false;
  var callState = 'off'; // off | listening | processing | speaking
  var chatStarted = false; // true once the greeting has been shown

  // ---------- rendering ----------
  function scrollDown() { elMessages.scrollTop = elMessages.scrollHeight; }
  function addMessage(role, text) {
    var div = document.createElement('div');
    div.className = 'pb-msg ' + (role === 'user' ? 'user' : 'bot');
    div.textContent = text;
    elMessages.appendChild(div);
    scrollDown();
    return div;
  }
  // The agent sends several short messages per reply, one per line. Show each as
  // its own bubble with a short "typing" pause between them.
  function splitBubbles(text) {
    return String(text).split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function addBotMessages(text) {
    var parts = splitBubbles(text);
    if (parts.length <= 1) { addMessage('bot', text); return Promise.resolve(); }
    addMessage('bot', parts[0]);
    return parts.slice(1).reduce(function (p, part) {
      return p.then(function () {
        showTyping();
        return new Promise(function (r) { setTimeout(r, Math.min(1200, 350 + part.length * 12)); })
          .then(function () { hideTyping(); addMessage('bot', part); });
      });
    }, Promise.resolve());
  }
  // For speech: one sentence per line so it reads naturally aloud.
  function forSpeech(text) {
    return splitBubbles(text).map(function (s) { return /[.!?]$/.test(s) ? s : s + '.'; }).join(' ');
  }

  function showTyping() {
    if ($('pb-typing')) return;
    var d = document.createElement('div');
    d.className = 'pb-typing';
    d.id = 'pb-typing';
    d.innerHTML = '<span></span><span></span><span></span>';
    elMessages.appendChild(d);
    scrollDown();
  }
  function hideTyping() { var d = $('pb-typing'); if (d) d.remove(); }
  function showError(msg) {
    elError.textContent = msg;
    elError.hidden = false;
    setTimeout(function () { elError.hidden = true; }, 6000);
  }
  function setAvatarState(state) {
    elAvatar.classList.toggle('pb-talking', state === 'talking');
    elAvatar.classList.toggle('pb-listening', state === 'listening');
    if (elRing) {
      elRing.classList.toggle('pb-ring-talk', state === 'talking');
      elRing.classList.toggle('pb-ring-listen', state === 'listening');
    }
  }
  function setCaption(txt) { elCaption.textContent = txt || ''; }
  function setCallStatus(txt) { if (elCallStatus) elCallStatus.textContent = txt || ''; }

  // ---------- text to speech ----------
  var synth = window.speechSynthesis;
  var preferredVoice = null;
  var voicePitch = 1;
  // The agent is a man, so prefer a male voice. Browsers don't expose voice
  // gender, so match known male voice names (Chrome, Edge/Windows, macOS/iOS).
  var MALE_VOICE_RE = /\b(male|guy|andrew|brian|christopher|eric|roger|steffan|ryan|thomas|liam|william|david|mark|james|george|daniel|alex|fred|aaron|arthur|gordon|oliver|rishi|tom|reed|evan|nathan)\b/i;
  var FEMALE_VOICE_RE = /\b(female|woman|zira|aria|jenny|michelle|ana|emma|ava|samantha|victoria|karen|moira|tessa|fiona|susan|hazel|libby|sonia|natasha|allison|serena|kate|zoe|google us english)\b/i;
  function pickVoice() {
    if (!synth) return;
    var voices = synth.getVoices();
    if (!voices.length) return;
    var lang = (navigator.language || 'en-US').toLowerCase();
    var isMale = function (v) { return MALE_VOICE_RE.test(v.name) && !FEMALE_VOICE_RE.test(v.name); };
    var natural = function (v) { return /google|natural|premium|neural|online|enhanced/i.test(v.name); };
    var sameLang = function (v) { return v.lang.toLowerCase() === lang; };
    var english = function (v) { return v.lang.toLowerCase().slice(0, 2) === 'en'; };
    var male =
      voices.find(function (v) { return isMale(v) && sameLang(v) && natural(v); }) ||
      voices.find(function (v) { return isMale(v) && english(v) && natural(v); }) ||
      voices.find(function (v) { return isMale(v) && sameLang(v); }) ||
      voices.find(function (v) { return isMale(v) && english(v); });
    if (male) {
      preferredVoice = male;
      voicePitch = 1;
      return;
    }
    // No male voice installed: use the best non-female English voice, pitched down.
    preferredVoice =
      voices.find(function (v) { return english(v) && !FEMALE_VOICE_RE.test(v.name) && natural(v); }) ||
      voices.find(function (v) { return english(v) && !FEMALE_VOICE_RE.test(v.name); }) ||
      voices.find(function (v) { return english(v); }) ||
      voices[0];
    voicePitch = 0.75;
  }
  if (synth) {
    pickVoice();
    synth.addEventListener('voiceschanged', pickVoice);
  }
  // Browsers load voices asynchronously; speaking before they arrive uses the
  // default (often female) voice, so the greeting started in a woman's voice and
  // switched mid-way. Wait for the voice list (max ~2s) before the first utterance.
  var voicesReady = new Promise(function (resolve) {
    if (!synth || synth.getVoices().length) { resolve(); return; }
    var tries = 0;
    var timer = setInterval(function () {
      if (synth.getVoices().length || ++tries > 20) {
        clearInterval(timer);
        pickVoice();
        resolve();
      }
    }, 100);
    synth.addEventListener('voiceschanged', function () {
      if (synth.getVoices().length) { clearInterval(timer); pickVoice(); resolve(); }
    });
  });
  var speakToken = 0; // bumped on every speak/stop so a stale queued speak() never starts

  function stopSpeaking() {
    speakToken++;
    if (synth) synth.cancel();
    if (head) head.stop();
    setAvatarState(null);
    if (elCaption.textContent === 'Speaking') setCaption('');
  }

  // speak text; call done() when finished (or immediately if we can't speak)
  function speak(text, done) {
    done = done || function () {};
    if (!synth || muted || !text) { done(); return; }
    var token = ++speakToken;
    voicesReady.then(function () {
      if (token !== speakToken || muted) return; // cancelled while waiting for voices
      speakNow(text, done);
    });
  }

  function speakNow(text, done) {
    synth.cancel();
    // Speak a few sentences per utterance: each utterance on a network voice
    // (Chrome's Google voices) costs a round trip, so one per sentence left
    // audible gaps. Stay under ~160 chars - Chrome cuts off very long ones.
    var sentences = String(text).match(/[^.!?]+[.!?]*/g) || [text];
    var chunks = [];
    sentences.forEach(function (sn) {
      sn = sn.trim();
      if (!sn) return;
      var last = chunks[chunks.length - 1];
      if (last && last.length + sn.length < 160) chunks[chunks.length - 1] = last + ' ' + sn;
      else chunks.push(sn);
    });
    if (!chunks.length) chunks = [String(text)];
    var i = 0;
    // one voice for the whole reply, even if the voice list changes mid-way
    var voice = preferredVoice;
    var pitch = voicePitch;
    setAvatarState('talking');
    setCaption('Speaking');
    function next() {
      if (head) head.stop();
      if (i >= chunks.length) {
        setAvatarState(null);
        if (elCaption.textContent === 'Speaking') setCaption('');
        done();
        return;
      }
      var line = chunks[i++].trim();
      var u = new SpeechSynthesisUtterance(line);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = 1.03;
      u.pitch = pitch;
      // lip-sync: start the mouth with the audio, re-sync on every word
      u.onstart = function () { if (head) head.start(line, u.rate); };
      u.onboundary = function (e) { if (head && e.name !== 'sentence') head.sync(e.charIndex); };
      u.onend = next;
      u.onerror = function () { if (head) head.stop(); setAvatarState(null); done(); };
      synth.speak(u);
    }
    next();
  }

  // ---------- speech recognition ----------
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognition = null;
  var recActive = false;      // recognition currently running
  var pttRecording = false;   // push-to-talk session active
  var finalTranscript = '';
  // Lowest confidence Chrome gave the finalised words (0 = not reported).
  // Background TV / music / other voices come back with low confidence.
  var finalConfidence = 0;
  var MIN_CONFIDENCE = 0.4;
  var callRetry = 0;
  // The visitor's turn ends only after this much silence. Recognition runs in
  // continuous mode, so short pauses mid-sentence (to think or breathe) no
  // longer cut them off and send half a sentence.
  var TURN_SILENCE_MS = 1600;
  var silenceTimer = 0;
  // Always listen in English: following the browser's UI language (e.g. Urdu)
  // turned spoken English into nonsense. ?voiceLang=en-IN etc. overrides it.
  var nav = navigator.language || '';
  var VOICE_LANG = params.get('voiceLang') || (/^en\b/i.test(nav) ? nav : 'en-US');

  if (SR) {
    recognition = new SR();
    recognition.lang = VOICE_LANG;
    recognition.maxAlternatives = 1;
    recognition.interimResults = true;
    recognition.continuous = true; // we end the turn ourselves after TURN_SILENCE_MS

    recognition.onstart = function () {
      console.log('[voice] listening, lang', recognition.lang);
      recActive = true;
      finalTranscript = '';
      finalConfidence = 0;
      if (callMode) {
        callState = 'listening';
        setAvatarState('listening');
        setCallStatus('Listening…');
        if (elCallLive) elCallLive.textContent = '';
      } else {
        pttRecording = true;
        elMic.classList.add('pb-recording');
        setAvatarState('listening');
        setCaption('Listening');
      }
    };

    recognition.onresult = function (e) {
      // Continuous mode keeps every phrase of the turn in e.results; rebuild
      // the whole transcript each time so nothing is duplicated or dropped.
      var interim = '';
      finalTranscript = '';
      finalConfidence = 0;
      for (var i = 0; i < e.results.length; i++) {
        var t = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          finalTranscript += (finalTranscript ? ' ' : '') + t.trim();
          var c = e.results[i][0].confidence;
          if (c > 0) finalConfidence = finalConfidence ? Math.min(finalConfidence, c) : c;
        } else interim += t;
      }
      // Still talking: push the end of the turn back.
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(function () {
        if (recActive) { try { recognition.stop(); } catch (x) {} } // stop() still delivers the final result
      }, TURN_SILENCE_MS);
      var shown = (finalTranscript + ' ' + interim).trim();
      console.log('[voice] heard:', shown, finalTranscript && !interim ? '(final, confidence ' + finalConfidence.toFixed(2) + ')' : '(guess)');
      if (callMode) {
        if (elCallLive) elCallLive.textContent = shown;
      } else {
        elText.value = shown;
        autosize();
      }
    };

    // Every recognition failure is shown on screen (and logged) - silent
    // failures just looked like "it isn't listening".
    recognition.onerror = function (e) {
      console.warn('[voice] recognition error:', e.error, e.message || '', '| lang', recognition.lang);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        showError('Microphone permission is blocked. Click the lock icon in the address bar and allow the microphone.');
        if (callMode) exitCall();
      } else if (e.error === 'audio-capture') {
        showError('No microphone found. Check that a mic is connected and selected in your system sound settings.');
        if (callMode) exitCall();
      } else if (e.error === 'language-not-supported' && recognition.lang !== 'en-US') {
        recognition.lang = 'en-US';
        showError('Voice language not supported, switched to US English. Please try again.');
      } else if (e.error === 'network') {
        if (callMode) setCallStatus('Cannot reach the voice service, retrying…');
        else showError('Voice typing needs an internet connection (Chrome sends audio to Google). Please try again.');
      } else if (e.error === 'no-speech') {
        if (callMode) setCallStatus("I can't hear you - check your microphone. Listening…");
        else showError("I didn't hear anything. Check that your microphone is on and not muted.");
      }
    };

    recognition.onend = function () {
      recActive = false;
      clearTimeout(silenceTimer);
      if (callMode) {
        if (callState !== 'listening') return; // we stopped it on purpose
        var text = finalTranscript.trim();
        if (text && isUnclear()) {
          // Probably background noise: don't send it, just ask again.
          callRetry = 0;
          if (elCallLive) elCallLive.textContent = '';
          callState = 'speaking';
          setCallStatus("Sorry, I didn't catch that");
          speak("Sorry, I didn't catch that. Could you say it again?", function () {
            if (callMode) { setCallStatus('Listening…'); callListen(); }
          });
        } else if (text) {
          callRetry = 0;
          handleCallTurn(text);
        } else if (++callRetry < 8) {
          setTimeout(callListen, 250);
        } else {
          setCallStatus('Still there? Tap the mic circle or say something.');
          callRetry = 0;
          setTimeout(callListen, 400);
        }
      } else {
        pttRecording = false;
        elMic.classList.remove('pb-recording');
        setAvatarState(null);
        if (elCaption.textContent === 'Listening') setCaption('');
        var t = elText.value.trim();
        if (t && isUnclear()) {
          // Leave it in the box so the visitor can fix it and press send.
          showError("I didn't catch that clearly. Please check the text, then press send.");
          elText.focus();
        } else if (t) submit(t);
      }
    };

    function isUnclear() {
      return finalConfidence > 0 && finalConfidence < MIN_CONFIDENCE;
    }

    elMic.addEventListener('click', function () {
      if (callMode) return;
      if (pttRecording) { try { recognition.stop(); } catch (e) {} return; }
      stopSpeaking();
      try { recognition.start(); } catch (e) {}
    });
  } else {
    elMic.hidden = true;
    elCall.hidden = true;
  }

  // ---------- voice call mode ----------
  function callListen() {
    if (!callMode) return;
    if (recActive) return;
    callState = 'listening';
    try {
      recognition.start();
    } catch (e) {
      setTimeout(function () { if (callMode && !recActive) { try { recognition.start(); } catch (x) {} } }, 300);
    }
  }

  async function handleCallTurn(text) {
    callState = 'processing';
    setAvatarState(null);
    setCallStatus('Thinking…');
    if (elCallLive) elCallLive.textContent = text;
    addMessage('user', text);

    var reply = await sendToServer(text);
    if (!callMode) return;

    if (reply == null) {
      setCallStatus('Sorry, I missed that. Listening again…');
      setTimeout(callListen, 500);
      return;
    }
    addBotMessages(reply);
    if (elCallLive) elCallLive.textContent = '';
    callState = 'speaking';
    setCallStatus('Speaking…');
    speak(forSpeech(reply), function () {
      if (callMode) { setCallStatus('Listening…'); callListen(); }
    });
  }

  function enterCall() {
    if (!SR) { showError('Voice calls need Chrome or Edge.'); return; }
    if (callMode) return;
    callMode = true;
    callRetry = 0;
    elRoot.classList.add('pb-call');
    elCallUi.hidden = false;
    elCall.classList.add('pb-active');
    if (pttRecording) { try { recognition.stop(); } catch (e) {} }
    stopSpeaking();
    setCallStatus('Connecting…');
    // Short spoken cue, then start listening (user tapped, so audio is allowed).
    if (synth) { try { synth.resume(); } catch (e) {} }
    speak("You're connected. How can I help?", function () {
      if (callMode) { setCallStatus('Listening…'); callListen(); }
    });
  }

  function exitCall() {
    if (!callMode) return;
    callMode = false;
    callState = 'off';
    elRoot.classList.remove('pb-call');
    elCallUi.hidden = true;
    elCall.classList.remove('pb-active');
    setAvatarState(null);
    setCaption('');
    stopSpeaking();
    try { recognition.abort(); } catch (e) {}
  }

  elCall.addEventListener('click', function () { callMode ? exitCall() : enterCall(); });
  elCallEnd.addEventListener('click', exitCall);
  elCallMute.addEventListener('click', function () { setMuted(!muted); });

  // Tap the avatar to interrupt the assistant while it's speaking in a call.
  elAvatar.addEventListener('click', function () {
    if (callMode && callState === 'speaking') {
      stopSpeaking();
      setCallStatus('Listening…');
      callListen();
    }
  });

  // ---------- mute ----------
  function setMuted(v) {
    muted = v;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) {}
    document.body.classList.toggle('pb-muted', muted);
    if (elCallMute) elCallMute.classList.toggle('pb-on', muted);
    if (muted) stopSpeaking();
  }
  elMute.addEventListener('click', function () { setMuted(!muted); });

  // ---------- close ----------
  elClose.addEventListener('click', function () {
    exitCall();
    stopSpeaking();
    if (window.parent !== window && PARENT_ORIGIN) {
      window.parent.postMessage({ type: 'sireprinting:close' }, PARENT_ORIGIN);
    }
  });

  // ---------- lead / callback form ----------
  function openLeadForm() {
    exitCall();
    elLeadForm.hidden = false;
    elLeadDone.hidden = true;
    elLeadErr.hidden = true;
    elLeadSubmit.disabled = false;
    elLead.hidden = false;
    var nameInput = elLeadForm.elements.name;
    setTimeout(function () { try { nameInput.focus(); } catch (e) {} }, 50);
  }
  function closeLeadForm() { elLead.hidden = true; }

  elQuote.addEventListener('click', openLeadForm);
  elLeadX.addEventListener('click', closeLeadForm);
  elLead.addEventListener('click', function (e) { if (e.target === elLead) closeLeadForm(); });

  elLeadForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    elLeadErr.hidden = true;
    var f = elLeadForm.elements;
    var name = (f.name.value || '').trim();
    var email = (f.email.value || '').trim();
    var phone = (f.phone.value || '').trim();
    var message = (f.message.value || '').trim();

    if (name.length < 2) { showLeadError('Please enter your name.'); return; }
    if (!email && !phone) { showLeadError('Please add an email or a phone number.'); return; }

    elLeadSubmit.disabled = true;
    elLeadSubmit.textContent = 'Sending…';
    try {
      var res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name, email: email, phone: phone, message: message,
          conversationId: conversationId,
          siteId: SITE_ID,
          siteOrigin: PARENT_ORIGIN || undefined,
        }),
      });
      var data = await res.json();
      if (!res.ok) { showLeadError(data.error || 'Could not send. Please try again.'); return; }
      elLeadForm.hidden = true;
      elLeadDone.hidden = false;
      addMessage('bot', "Thanks " + name + "! Your request is in — a Sire Printing rep will contact you soon.");
      setTimeout(closeLeadForm, 2600);
      elLeadForm.reset();
    } catch (err) {
      showLeadError('Network error. Please try again.');
    } finally {
      elLeadSubmit.disabled = false;
      elLeadSubmit.textContent = 'Send request';
    }
  });
  function showLeadError(msg) { elLeadErr.textContent = msg; elLeadErr.hidden = false; }

  // ---------- text input ----------
  function autosize() {
    elText.style.height = '40px';
    var h = Math.max(40, Math.min(elText.scrollHeight, 104));
    elText.style.height = h + 'px';
    elText.style.overflowY = elText.scrollHeight > 104 ? 'auto' : 'hidden';
    elSend.disabled = sending || !elText.value.trim();
  }
  elText.addEventListener('input', autosize);
  elText.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); elForm.requestSubmit(); }
  });
  elForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = elText.value.trim();
    if (text) submit(text);
  });

  // ---------- server call ----------
  // Returns the reply string, or null on failure.
  async function sendToServer(text) {
    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversationId,
          message: text,
          siteId: SITE_ID,
          siteOrigin: PARENT_ORIGIN || undefined,
          language: navigator.language,
          pageUrl: PAGE_URL || undefined,
        }),
      });
      var data = await res.json();
      // The server can refuse with a message for the visitor (e.g. the chat
      // length limit) - show/speak it as Zack's reply rather than an error.
      if (!res.ok && data.reply) return data.reply;
      if (!res.ok) {
        showError(data.error || 'Something went wrong. Please try again.');
        return null;
      }
      if (data.conversationId) {
        conversationId = data.conversationId;
      }
      if (data.showLeadForm) setTimeout(openLeadForm, 400);
      return data.reply || '';
    } catch (err) {
      showError('Cannot reach the assistant. Check your connection and try again.');
      return null;
    }
  }

  // Text / push-to-talk submit
  async function submit(text) {
    if (sending) return;
    sending = true;
    stopSpeaking();
    addMessage('user', text);
    elText.value = '';
    autosize();
    elSend.disabled = true;
    showTyping();

    var reply = await sendToServer(text);
    hideTyping();
    if (reply != null) {
      speak(forSpeech(reply));
      await addBotMessages(reply);
    }
    sending = false;
    autosize();
  }

  // ---------- boot ----------
  function maybeSpeakGreeting() {
    if (!chatStarted) return;
    if (synth) { try { synth.resume(); } catch (x) {} }
    if (!sessionStorage.getItem('sireprinting:greeted')) {
      sessionStorage.setItem('sireprinting:greeted', '1');
      speak(forSpeech(GREETING));
    }
  }
  function startChat() {
    if (chatStarted) return;
    chatStarted = true;
    addBotMessages(GREETING);
    autosize();
    maybeSpeakGreeting();
  }

  window.addEventListener('message', function (e) {
    if (PARENT_ORIGIN && e.origin !== PARENT_ORIGIN) return;
    if (e.data && e.data.type === 'sireprinting:opened') maybeSpeakGreeting();
  });

  // No form up front: Zack greets the visitor and asks for their details in the chat.
  startChat();

  autosize();
  requestAnimationFrame(autosize);
  window.addEventListener('load', autosize);
})();
