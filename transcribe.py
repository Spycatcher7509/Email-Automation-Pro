#!/usr/bin/env python3
"""
Whisper-based voice transcription for Email Automation Pro
Records audio and transcribes using OpenAI Whisper with Apple Silicon acceleration
Supports: CPU and MPS (Metal) for M1/M2/M3 Macs

Modes:
  default   -- record once, print transcription to stdout, exit
  --daemon  -- persistent process: read JSON commands from stdin, write JSON results to stdout
               (keeps the Whisper model in memory between calls for faster repeated use)
"""

import sys
import os
import sounddevice as sd
import numpy as np
from scipy.io.wavfile import write
import tempfile
import argparse
from multiprocessing import freeze_support

# Fix for PyInstaller multiprocessing on macOS
freeze_support()


def get_device():
    """Automatically detect best available device for Apple Silicon."""
    import torch
    if torch.backends.mps.is_available():
        print("🚀 Using Apple Silicon GPU (Metal)", file=sys.stderr)
        return "mps"
    print("💻 Using CPU", file=sys.stderr)
    return "cpu"


def record_audio(duration=5, sample_rate=16000):
    """Record audio from microphone."""
    print(f"🎤 Recording for {duration} seconds...", file=sys.stderr)
    try:
        recording = sd.rec(int(duration * sample_rate),
                           samplerate=sample_rate,
                           channels=1,
                           dtype='int16')
        sd.wait()
        print("✅ Recording complete", file=sys.stderr)
        return recording, sample_rate
    except Exception as e:
        print(f"❌ Recording error: {e}", file=sys.stderr)
        raise


def transcribe_audio(audio_data, sample_rate, model_size='base', device='cpu', loaded_model=None):
    """
    Transcribe audio using Whisper.

    If `loaded_model` is provided (daemon mode) it is used directly, skipping the
    load step.  Otherwise the model is loaded fresh from disk.
    """
    import whisper

    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp_file:
        tmp_path = tmp_file.name
        write(tmp_path, sample_rate, audio_data)

    try:
        if loaded_model is not None:
            model = loaded_model
        else:
            print(f"🔄 Loading Whisper model ({model_size}) on {device}...", file=sys.stderr)
            model = whisper.load_model(model_size)
            if device == "mps":
                try:
                    model = model.to(device)
                    print("✅ Model loaded on Apple Silicon GPU", file=sys.stderr)
                except Exception as e:
                    print(f"⚠️  GPU loading failed, falling back to CPU: {e}", file=sys.stderr)
                    model = model.to("cpu")
            else:
                model = model.to(device)

        print("🔄 Transcribing...", file=sys.stderr)
        result = model.transcribe(tmp_path, language='en', fp16=False)
        return result['text'].strip()

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def daemon_mode():
    """
    Persistent daemon: keeps the Whisper model in memory between transcription
    calls.  Reads newline-delimited JSON commands from stdin, writes JSON results
    to stdout.

    Input:  {"action": "transcribe", "duration": 5, "model": "base"}
    Output: {"success": true, "text": "..."} | {"success": false, "error": "..."}
    """
    import json
    import whisper
    import traceback

    model_cache = {}  # model_size -> (model, device)

    print(json.dumps({"status": "ready"}), flush=True)
    print("🚀 Whisper daemon started — model will be cached after first use", file=sys.stderr)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            command = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON: {e}"}), flush=True)
            continue

        if command.get('action') != 'transcribe':
            print(json.dumps({"success": False, "error": "Unknown action"}), flush=True)
            continue

        duration = command.get('duration', 5)
        model_size = command.get('model', 'base')

        try:
            audio_data, sample_rate = record_audio(duration=duration)

            if model_size not in model_cache:
                print(f"🔄 Loading Whisper model ({model_size})...", file=sys.stderr)
                device = get_device()
                model = whisper.load_model(model_size)
                if device == 'mps':
                    try:
                        model = model.to(device)
                        print("✅ Model loaded on Apple Silicon GPU", file=sys.stderr)
                    except Exception as e:
                        print(f"⚠️  GPU loading failed, falling back to CPU: {e}", file=sys.stderr)
                        device = 'cpu'
                        model = model.to(device)
                else:
                    model = model.to(device)
                model_cache[model_size] = (model, device)
                print("✅ Model cached — subsequent calls will be faster", file=sys.stderr)

            model, _ = model_cache[model_size]
            text = transcribe_audio(audio_data, sample_rate, loaded_model=model)
            print(json.dumps({"success": True, "text": text}), flush=True)

        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({"success": False, "error": str(e)}), flush=True)


def main():
    parser = argparse.ArgumentParser(
        description='Transcribe audio using Whisper with Apple Silicon acceleration'
    )
    parser.add_argument('--duration', type=int, default=5,
                        help='Recording duration in seconds (default: 5)')
    parser.add_argument('--model', type=str, default='base',
                        choices=['tiny', 'base', 'small', 'medium', 'large'],
                        help='Whisper model size (default: base)')
    parser.add_argument('--device', type=str, default='auto',
                        choices=['auto', 'mps', 'cpu'],
                        help='Device to use: auto (detect), mps (Apple Silicon GPU), or cpu (default: auto)')
    parser.add_argument('--daemon', action='store_true',
                        help='Run as persistent daemon (reads commands from stdin)')

    args = parser.parse_args()

    if args.daemon:
        daemon_mode()
        return

    try:
        # Record audio before loading heavy libraries to minimise perceived latency
        audio_data, sample_rate = record_audio(duration=args.duration)

        if args.device == 'auto':
            device = get_device()
        else:
            device = args.device
            import torch
            if device == 'mps' and not torch.backends.mps.is_available():
                print("⚠️  MPS not available, falling back to CPU", file=sys.stderr)
                device = 'cpu'

        text = transcribe_audio(audio_data, sample_rate, model_size=args.model, device=device)
        print(text)

    except KeyboardInterrupt:
        print("\n⚠️ Recording cancelled", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
