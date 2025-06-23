import { initDB, saveReference, getAllReferences } from './storage.js';

// --- State ---
let counter = 0;
let running = false;
let stream, audioCtx, processor;
let cooldown = 0;
const COOLDOWN_FRAMES = 10;
const THRESHOLD = 0.23;
const FFT_SIZE = 2048;
const SIMILARITY_THRESHOLD = 0.95; // High threshold for tight matching

// Reference pop recording state
let refSamples = [];
let refRecording = false;
let refAudioChunks = [];
let refRecorder = null;

// --- DOM Elements ---
const counterDiv = document.getElementById('counter');
const statusDiv = document.getElementById('status');
const toggleBtn = document.getElementById('toggle');
const recordRefBtn = document.getElementById('record-ref');
const recStatus = document.getElementById('rec-status');
const refList = document.getElementById('ref-list');

// --- UI Functions ---
function updateCounter() {
  counterDiv.textContent = counter;
}

function setStatus(msg) {
  statusDiv.textContent = msg;
}

function renderRefList() {
  refList.innerHTML = '';
  refSamples.forEach((sample, i) => {
    const li = document.createElement('li');
    li.style.margin = '8px 0';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = sample.url;
    audio.style.verticalAlign = 'middle';
    li.appendChild(document.createTextNode(`Ref #${i + 1}: `));
    li.appendChild(audio);
    refList.appendChild(li);
  });
}

// --- Audio Analysis ---
function getFeatures(buffer) {
  const fft = new FFT(FFT_SIZE, audioCtx.sampleRate);
  fft.forward(buffer);
  return fft.spectrum;
}

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  return dotProduct / (magA * magB);
}

async function analyzeAndCompare(popBuffer) {
  if (refSamples.length === 0) {
    setStatus('No reference pops to compare against!');
    return;
  }

  const popFeatures = getFeatures(popBuffer);
  let bestMatch = { score: -1, index: -1 };

  for (let i = 0; i < refSamples.length; i++) {
    const ref = refSamples[i];
    if (!ref.features) {
      // Lazy feature extraction for references
      const buffer = await audioCtx.decodeAudioData(await ref.blob.arrayBuffer());
      ref.features = getFeatures(buffer.getChannelData(0));
    }

    const score = cosineSimilarity(popFeatures, ref.features);
    if (score > bestMatch.score) {
      bestMatch = { score, index: i };
    }
  }

  if (bestMatch.score > SIMILARITY_THRESHOLD) {
    counter++;
    updateCounter();
    setStatus(`Pop! Matched Ref #${bestMatch.index + 1} (Score: ${bestMatch.score.toFixed(2)})`);
    cooldown = COOLDOWN_FRAMES;
  } else {
    setStatus(`Pop detected, but no match (Best: #${bestMatch.index + 1}, Score: ${bestMatch.score.toFixed(2)})`);
  }
}

// --- Counter Logic ---
async function startCounter() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const source = audioCtx.createMediaStreamSource(stream);
    processor = audioCtx.createScriptProcessor(FFT_SIZE, 1, 1);
    source.connect(processor);
    processor.connect(audioCtx.destination);
    setStatus('Listening... Pop your mouth!');
    running = true;
    toggleBtn.textContent = 'Stop';

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      let max = 0;
      for (let i = 0; i < input.length; i++) {
        max = Math.max(max, Math.abs(input[i]));
      }
      if (cooldown > 0) {
        cooldown--;
        return;
      }
      if (max > THRESHOLD) {
        analyzeAndCompare(input);
      }
    };
  } catch (err) {
    setStatus('Microphone access denied or not available.');
    console.error(err);
  }
}

function stopCounter() {
  if (processor) processor.disconnect();
  if (stream) stream.getTracks().forEach(track => track.stop());
  setStatus('Stopped.');
  running = false;
  toggleBtn.textContent = 'Start';
}

// --- Reference Recording Logic ---
async function handleRefRecord() {
  if (!refRecording) {
    try {
      const recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      refRecorder = new MediaRecorder(recStream);
      refAudioChunks = [];
      recStatus.textContent = 'Recording...';
      recordRefBtn.textContent = 'Stop Recording';
      refRecording = true;

      refRecorder.ondataavailable = e => refAudioChunks.push(e.data);
      refRecorder.onstop = async () => {
        const blob = new Blob(refAudioChunks, { type: 'audio/webm' });
        await saveReference(blob);
        await loadReferences(); // Reload all from DB
        recStatus.textContent = `Saved reference #${refSamples.length}`;
        setTimeout(() => { recStatus.textContent = ''; }, 1600);
        recStream.getTracks().forEach(track => track.stop());
      };
      refRecorder.start();
    } catch (e) {
      recStatus.textContent = 'Mic access denied!';
    }
  } else {
    refRecorder.stop();
    recordRefBtn.textContent = 'Record Reference Pop';
    refRecording = false;
  }
}

// --- Initialization ---
async function loadReferences() {
  const refsFromDB = await getAllReferences();
  refSamples = refsFromDB.map(r => ({ ...r, url: URL.createObjectURL(r.blob) }));
  renderRefList();
}

async function main() {
  await initDB();
  await loadReferences();
  updateCounter();
  setStatus('Record some reference pops or click Start!');

  toggleBtn.onclick = () => {
    if (!running) startCounter();
    else stopCounter();
  };

  recordRefBtn.onclick = handleRefRecord;
}

main();
