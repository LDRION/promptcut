"""
face_track.py — dense per-frame face trajectory for the face-lock camera.

The engine glues the camera to the head, so it needs the head's path through the
WHOLE clip, not just its endpoints. For each segment we sample the source at
`sampleFps` and report the face centre + size at every sample (null where none is
found). The engine fills gaps, smooths, and drives a follow-crop from the trajectory.

Detector: OpenCV's YuNet (models/face_detection_yunet_2023mar.onnx) — it finds small
faces too (a streamer's facecam in a corner is ~3% of the frame wide), which
MediaPipe's selfie-range detector misses entirely. MediaPipe FaceLandmarker is the
fallback when YuNet isn't available (OpenCV < 4.8).

stdin  (JSON): { "video": path, "sampleFps": 15,
                 "segments": [ {"off": seconds, "dur": seconds}, ... ] }
stdout (JSON): { "w": W, "h": H, "srcFps": fps,
                 "clips": [ { "found": bool, "det": 0..1,
                              "traj": [ [t_rel, cx, cy, size] | [t_rel, null, null, null], ... ] }, ... ] }

cx, cy, size (face width) are normalised [0..1] to the FULL source frame; t_rel is
seconds from the segment start. Degrades to found:false everywhere if the libraries
are missing.
"""
import sys
import os
import json

MODELS = os.path.join(os.path.dirname(__file__), "models")
YUNET_PATH = os.path.join(MODELS, "face_detection_yunet_2023mar.onnx")
LANDMARKER_PATH = os.path.join(MODELS, "face_landmarker.task")
LANDMARKER_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
DETECT_W = 1280  # detection resolution cap: small faces survive, 1440p stays fast


def yunet_detector(cv2):
    """frame(BGR) → [(cx, cy, w, score)] normalised, via YuNet."""
    if not (os.path.exists(YUNET_PATH) and hasattr(cv2, "FaceDetectorYN")):
        return None
    net = cv2.FaceDetectorYN.create(YUNET_PATH, "", (320, 320), 0.6, 0.3, 20)
    size = [None]

    def detect(frame):
        h, w = frame.shape[:2]
        scale = min(1.0, DETECT_W / w)
        img = frame if scale == 1.0 else cv2.resize(frame, (int(w * scale), int(h * scale)))
        ih, iw = img.shape[:2]
        if size[0] != (iw, ih):
            net.setInputSize((iw, ih))
            size[0] = (iw, ih)
        _, faces = net.detect(img)
        if faces is None:
            return []
        return [(float((x + fw / 2) / iw), float((y + fh / 2) / ih), float(fw / iw), float(s))
                for x, y, fw, fh, *_, s in faces]

    return detect


def mediapipe_detector(cv2):
    """frame(BGR) → [(cx, cy, w, score)] normalised, via MediaPipe FaceLandmarker."""
    import numpy as np
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    if not os.path.exists(LANDMARKER_PATH):
        import urllib.request
        os.makedirs(MODELS, exist_ok=True)
        urllib.request.urlretrieve(LANDMARKER_URL, LANDMARKER_PATH)
    landmarker = vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=LANDMARKER_PATH),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=3,
            min_face_detection_confidence=0.25,
        )
    )

    def detect(frame):
        rgb = np.ascontiguousarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        res = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
        out = []
        for pts in res.face_landmarks or []:
            xs = [p.x for p in pts]
            ys = [p.y for p in pts]
            out.append((sum(xs) / len(xs), sum(ys) / len(ys), max(xs) - min(xs), 1.0))
        return out

    return detect


def pick(faces, prev):
    """Stay on the same face within a clip; otherwise take the most prominent one."""
    if not faces:
        return None
    if prev is not None:
        near = min(faces, key=lambda f: (f[0] - prev[0]) ** 2 + (f[1] - prev[1]) ** 2)
        if (near[0] - prev[0]) ** 2 + (near[1] - prev[1]) ** 2 < (3 * max(prev[2], 0.02)) ** 2:
            return near
    return max(faces, key=lambda f: f[2] * f[3])


def main():
    req = json.load(sys.stdin)
    video = req["video"]
    segments = req["segments"]
    sample_fps = float(req.get("sampleFps", 15))

    def fail(w=0, h=0, fps=0.0):
        print(json.dumps({
            "w": w, "h": h, "srcFps": fps,
            "clips": [{"found": False, "det": 0.0, "traj": []} for _ in segments],
        }))

    try:
        import cv2
        detect = yunet_detector(cv2)
        if detect is None:
            detect = mediapipe_detector(cv2)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"face_track init failed: {e}\n")
        fail()
        return

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        fail()
        return
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    clips = []
    for seg in segments:
        off = max(0.0, float(seg["off"]))
        dur = max(0.1, float(seg["dur"]))
        n = max(2, int(round(dur * sample_fps)))
        traj = []
        det = 0
        prev = None
        for k in range(n):
            t_rel = dur * k / (n - 1)
            cap.set(cv2.CAP_PROP_POS_MSEC, (off + t_rel) * 1000.0)
            ok, frame = cap.read()
            face = pick(detect(frame), prev) if ok and frame is not None else None
            if face:
                traj.append([round(t_rel, 3), round(face[0], 4), round(face[1], 4), round(face[2], 4)])
                det += 1
                prev = face
            else:
                traj.append([round(t_rel, 3), None, None, None])
        rate = det / max(1, n)
        clips.append({"found": rate >= 0.4, "det": round(rate, 2), "traj": traj})

    cap.release()
    print(json.dumps({"w": W, "h": H, "srcFps": round(src_fps, 3), "clips": clips}))


if __name__ == "__main__":
    main()
