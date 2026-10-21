# WAV to MP3 Converter — specification

**Tagline:** Convert WAV, FLAC, M4A and OGG files to MP3 in your browser with chosen bitrate, no upload.

**Category:** Audio & Video

**Free alternative to:** CloudConvert WAV to MP3 (uploads files to a server, limited free conversions per day, account needed for more) and Convertio (100 MB cap on free plan)

**Search phrases:** wav to mp3, convert wav to mp3, wav to mp3 online free, flac to mp3, m4a to mp3, ogg to mp3, batch audio converter

**Allowed libraries:** lamejs, fflate

**Published at:** https://turhe123.github.io/wav-to-mp3-local/

## Acceptance checks (each must have a test)

- Dropping sample.wav produces a downloadable MP3 smaller than the WAV
- The result list shows original size, new size and the reduction percentage
- Choosing 320 kbps gives a larger file than 128 kbps for the same input
- Dropping three files and pressing Download all produces a ZIP with three MP3 files
- A non audio file is rejected with a message
- Works at 390px wide

## Spec

Wav to mp3 is a classic high volume search. People need smaller files for email, uploads, music players, phone recordings and game assets. The big conversion sites upload the files to their servers, give a small number of free conversions per day, limit size on free plans and add ads or sign-up prompts. Our version converts local audio to MP3 and nothing else, with batch support.

Feature set: accept multiple files of WAV, FLAC, M4A, OGG, AAC or MP3 as far as the browser can decode. Options: bitrate 64, 96, 128, 160, 192, 256, 320 kbps with default 192, mode stereo or mono (default keep source), and sample rate keep or 44100 or 48000. Show a result row per file with original size, MP3 size, saving, duration and a Download button, and a Download all as ZIP button when more than one file is converted. Output names keep the base name with the mp3 extension, with a numeric suffix on collisions. Metadata is not edited.

UI: a large drop zone with choose files button, options row, and below the file list with a status icon, progress bar and name for each file. A primary Convert button starts the queue, which runs one file at a time to limit memory. A clear list button resets. Empty state explains that files never leave the device. Errors appear on the failing row without stopping the others. Keyboard: Enter converts, Delete removes the focused row.

Technical approach: for each file read an ArrayBuffer, decode with an AudioContext decodeAudioData, resample through an OfflineAudioContext when a different sample rate is chosen, convert Float32 channels to Int16 and encode in a Web Worker with lamejs using blocks of 1152 samples. Post progress after each block. Combine the Uint8Array chunks into a Blob of type audio mpeg. For the ZIP use fflate zipSync with store mode since MP3 is already compressed, then download via an object URL. Revoke URLs when rows are removed. A per file size ceiling of about 500 MB is enforced with a clear message because decoding expands data in memory.

Edge cases: 24 bit and 32 bit float WAV files decode through the browser. Some browsers cannot decode FLAC or M4A so show a codec message on that row. Mono sources encoded as stereo waste space, so default to keep source. Safari needs the context created after a user gesture. Sample rates below 8000 or above 48000 are resampled to a supported value. Very long files should show a time estimate. Clipping is avoided by clamping samples. File names with Unicode characters are preserved.

Demo data: a bundled short generated WAV called sample with a piano-like arpeggio of two seconds, around 350 KB, so the size reduction is visible.
