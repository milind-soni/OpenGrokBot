// On-device dictation for the composer.
//
// Same engine as the desktop helper (`electron/resources/speech-helper.swift`):
// `SFSpeechRecognizer` on an `AVAudioEngine` tap, partials streamed into the
// text field, press to stop. Composer mode, not call mode — there is no
// silence endpointing. The phone is better at this than the Mac was: the
// recognizer is in the same process as the field, so there is no helper
// binary, no TCC bundle dance, and no `open -W`.
//
// On-device when the recognizer supports it, so talking to a bot does not
// become talking to Apple's servers. Locales come from `Dictation.localeCandidates`
// rather than a hardcoded en-US, for the same reason the desktop helper
// stopped hardcoding one.
//
// Lives in the app target on purpose. CompanionCore is Foundation-only so
// `swift test` can run without a simulator; Speech and AVAudioEngine are
// the opposite of that.
import AVFoundation
import Speech
import SwiftUI
import CompanionCore

@MainActor
final class SpeechDictation: ObservableObject {
    @Published private(set) var isListening = false
    @Published private(set) var transcript = ""
    @Published var error: String?

    /// Composer text captured when listening started. Frozen for the
    /// session so each partial replaces the last rather than stacking.
    /// ChatView reads this from `onChange(of: transcript)` and must not
    /// substitute the live draft.
    private(set) var base = ""

    private var recognizer: SFSpeechRecognizer?
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var stopping = false
    /// Bumped on every start/stop so an authorization that finishes after
    /// the user already cancelled cannot open the mic.
    private var generation = 0

    func toggle(capturing base: String) {
        if isListening {
            stop()
        } else {
            start(base: base)
        }
    }

    func start(base: String) {
        guard !isListening else { return }
        error = nil
        self.base = base.trimmingCharacters(in: .whitespacesAndNewlines)
        transcript = ""
        generation += 1
        let gen = generation
        Task { await actuallyStart(generation: gen) }
    }

    func stop() {
        generation += 1
        stopping = true
        isListening = false
        teardown()
    }

    // MARK: - Authorization

    private func actuallyStart(generation gen: Int) async {
        let speech = await requestSpeechAuthorization()
        guard gen == generation else { return }
        guard speech == .authorized else {
            error = Self.speechDeniedMessage
            return
        }

        let mic = await AVAudioApplication.requestRecordPermission()
        guard gen == generation else { return }
        guard mic else {
            error = Self.micDeniedMessage
            return
        }

        do {
            try beginCapture()
        } catch {
            self.error = "Couldn't start the microphone."
            teardown()
        }
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    // MARK: - Capture

    private func beginCapture() throws {
        let recognizer = Dictation.localeCandidates()
            .compactMap { SFSpeechRecognizer(locale: $0) }
            .first { $0.isAvailable }
        guard let recognizer else {
            error = "Dictation isn't available for this language."
            return
        }
        self.recognizer = recognizer

        let session = AVAudioSession.sharedInstance()
        // `.record` rather than `.playAndRecord`: this is composer
        // dictation, not a call, and holding the playback route would
        // duck whatever else is on the phone for no reason.
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // The desktop helper does not set this (it is a CLI talking to an
        // older Speech.framework), but a chat message is better with the
        // commas the recognizer already knows about.
        request.addsPunctuation = true
        request.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        // Keep the engine on self before start() so a throw still has
        // something for teardown to remove the tap from. A local engine
        // that fails to start would leave tapInstalled true and the next
        // teardown would removeTap on a new engine that has none — which
        // is an exception, not a no-op.
        audioEngine = engine
        recognitionRequest = request

        // The tap format is only valid after the session is active.
        // Installing against a 0-channel format is the usual "it works
        // in the sample and fails here" failure.
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0 else {
            throw CaptureError.silentInput
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        tapInstalled = true
        engine.prepare()
        try engine.start()

        stopping = false
        isListening = true

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                self?.handle(result: result, error: error)
            }
        }
    }

    private func handle(result: SFSpeechRecognitionResult?, error: Error?) {
        if let result {
            transcript = result.bestTranscription.formattedString
            // Composer dictation does not wait for isFinal — the last
            // partial is what you send. If the recognizer finalizes on
            // its own (rare without endAudio), just stop listening.
            if result.isFinal, isListening {
                stop()
            }
        }
        guard let error, !stopping, isListening else { return }
        let ns = error as NSError
        // 209/216 are the cancellation codes Speech uses when we tear
        // the task down ourselves. Surfacing those as "Couldn't
        // transcribe that" is how a tap-to-stop looks like a failure.
        if ns.domain == "kLSRErrorDomain", ns.code == 209 || ns.code == 216 {
            stop()
            return
        }
        self.error = "Couldn't transcribe that."
        stop()
    }

    private func teardown() {
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        if let engine = audioEngine {
            if engine.isRunning { engine.stop() }
            if tapInstalled {
                engine.inputNode.removeTap(onBus: 0)
                tapInstalled = false
            }
        }
        audioEngine = nil
        recognizer = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private enum CaptureError: Error {
        case silentInput
    }

    static let speechDeniedMessage =
        "Dictation needs Speech Recognition access. Enable it in Settings → OpenMausMobile."
    static let micDeniedMessage =
        "Dictation needs Microphone access. Enable it in Settings → OpenMausMobile."
}
