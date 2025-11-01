import sys
from tensorboard.backend.event_processing import event_accumulator
import json

if len(sys.argv) < 2:
    print(json.dumps({"error": "No experiment path provided"}))
    sys.exit(1)

experiment_path = sys.argv[1]

try:
    ea = event_accumulator.EventAccumulator(experiment_path)
    ea.Reload()

    data = {}
    for tag in ea.Tags()['scalars']:
        events = ea.Scalars(tag)
        data[tag] = {
            'steps': [e.step for e in events],
            'values': [e.value for e in events],
            'wall_times': [e.wall_time for e in events]
        }

    print(json.dumps(data))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
