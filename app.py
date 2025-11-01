from flask import Flask, render_template, jsonify, request, send_from_directory
import threading
import time
import os
import sys
import json
from datetime import datetime
from dotenv import load_dotenv
import subprocess

# Load environment variables
load_dotenv()

# Validate required environment variables
REQUIRED_ENV_VARS = [
    'SSH_HOST',
    'SSH_PORT',
    'SSH_KEY_PATH',
    'SSH_USERNAME',
    'TENSORBOARD_LOGS_PATH',
    'IMAGE_SAMPLES_PATH',
    'REMOTE_VENV_PATH',
    'MAIN_THREAD_OUTPUT'
]

missing_vars = [var for var in REQUIRED_ENV_VARS if not os.getenv(var)]
if missing_vars:
    print(f"ERROR: Missing required environment variables: {', '.join(missing_vars)}")
    print("Please create an .env file with all required variables.")
    sys.exit(1)

app = Flask(__name__)

# Global variables for storing data
tensorboard_data = {}
nvidia_smi_data = {
    'timestamps': [],
    'temperature': [],
    'power': [],
    'memory_used': [],
    'memory_total': []
}
tensorboard_experiments = []
data_lock = threading.Lock()
monitoring_active = False
monitoring_threads = []

# SSH Configuration from .env
SSH_HOST = os.getenv('SSH_HOST')
SSH_PORT = os.getenv('SSH_PORT')
SSH_KEY_PATH = os.path.expanduser(os.getenv('SSH_KEY_PATH'))
SSH_USERNAME = os.getenv('SSH_USERNAME')
TENSORBOARD_LOGS_PATH = os.getenv('TENSORBOARD_LOGS_PATH')
IMAGE_SAMPLES_PATH = os.getenv('IMAGE_SAMPLES_PATH')
REMOTE_VENV_PATH = os.getenv('REMOTE_VENV_PATH')
MAIN_THREAD_OUTPUT = os.getenv('MAIN_THREAD_OUTPUT')
LOCAL_IMAGES_PATH = os.path.join(os.path.dirname(__file__), 'static', 'images')
LOCAL_OUTPUT_PATH = os.path.join(os.path.dirname(__file__), 'static', 'output.txt')

# Remote script path
REMOTE_SCRIPT_PATH = '/home/user/remoteutil/extract_tensorboard.py'

# Ensure local images directory exists
os.makedirs(LOCAL_IMAGES_PATH, exist_ok=True)

# Load tensorboard extraction script
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TENSORBOARD_SCRIPT_PATH = os.path.join(SCRIPT_DIR, 'extract_tensorboard.py')

def run_ssh_command(command):
    """Helper function to run SSH command"""
    ssh_command = [
        'ssh',
        '-i', SSH_KEY_PATH,
        '-p', SSH_PORT,
        '-o', 'StrictHostKeyChecking=no',
        f'{SSH_USERNAME}@{SSH_HOST}',
        command
    ]
    
    result = subprocess.run(ssh_command, capture_output=True, text=True)
    return result.stdout, result.stderr, result.returncode

def run_rsync(source, destination, remote_to_local=True):
    """Helper function to run rsync command"""
    if remote_to_local:
        rsync_command = [
            'rsync',
            '-av',
            '-e', f'ssh -i {SSH_KEY_PATH} -p {SSH_PORT} -o StrictHostKeyChecking=no',
            f'{SSH_USERNAME}@{SSH_HOST}:{source}',
            destination
        ]
    else:
        rsync_command = [
            'rsync',
            '-av',
            '-e', f'ssh -i {SSH_KEY_PATH} -p {SSH_PORT} -o StrictHostKeyChecking=no',
            source,
            f'{SSH_USERNAME}@{SSH_HOST}:{destination}'
        ]
    command_str = " ".join(rsync_command)
    
    result = subprocess.run(rsync_command, capture_output=True, text=True)
    return command_str, result.stdout, result.stderr, result.returncode

def sync_tensorboard_script():
    """Sync the tensorboard extraction script to remote machine"""
    try:
        # Ensure remote directory exists
        remote_dir = os.path.dirname(REMOTE_SCRIPT_PATH)
        mkdir_command = f'mkdir -p {remote_dir}'
        run_ssh_command(mkdir_command)
        
        # Sync the script
        command_str, stdout, stderr, returncode = run_rsync(
            TENSORBOARD_SCRIPT_PATH,
            REMOTE_SCRIPT_PATH,
            remote_to_local=False
        )
        
        if returncode != 0:
            print(f"Error syncing tensorboard script: {stderr}")
            return False
        
        return True
    except Exception as e:
        print(f"Error syncing tensorboard script: {e}")
        return False

def list_tensorboard_experiments():
    """List all tensorboard experiment directories"""
    global tensorboard_experiments
    try:
        command = f'find {TENSORBOARD_LOGS_PATH} -type d -name "events.out.tfevents.*" -exec dirname {{}} \\;'
        stdout, stderr, returncode = run_ssh_command(command)
        
        if returncode != 0:
            print(f"Error listing tensorboard experiments: {stderr}")
            return {
                'experiments': [],
                'command': command,
                'stdout': stdout,
                'stderr': stderr,
                'returncode': returncode
            }
        
        experiments = stdout.strip().split('\n')
        experiments = [exp for exp in experiments if exp]  # Remove empty strings
        
        with data_lock:
            tensorboard_experiments = experiments
        
        return {
            'experiments': experiments,
            'command': command,
            'stdout': stdout,
            'stderr': stderr,
            'returncode': returncode
        }
    except Exception as e:
        print(f"Error listing tensorboard experiments: {e}")
        return {
            'experiments': [],
            'command': command if 'command' in locals() else '',
            'stdout': '',
            'stderr': str(e),
            'returncode': 1
        }

def fetch_tensorboard_data(experiment_path):
    """Fetch tensorboard data for a specific experiment"""
    global tensorboard_data
    try:
        # Execute the remote script with venv activated
        command = f'source {REMOTE_VENV_PATH}/bin/activate && python {REMOTE_SCRIPT_PATH} "{experiment_path}"'
        stdout, stderr, returncode = run_ssh_command(command)
        
        if returncode != 0 or not stdout:
            print(f"Error fetching tensorboard data: {stderr}")
            return {
                'data': None,
                'command': command,
                'stdout': stdout,
                'stderr': stderr,
                'returncode': returncode
            }
        
        data = json.loads(stdout)
        
        if 'error' in data:
            print(f"Error in tensorboard extraction: {data['error']}")
            return {
                'data': None,
                'command': command,
                'stdout': stdout,
                'stderr': stderr,
                'returncode': returncode,
                'error': data['error']
            }
        
        # Normalize path by removing leading slash for consistent dictionary keys
        normalized_path = experiment_path.lstrip('/')
        
        with data_lock:
            tensorboard_data[normalized_path] = data
        
        return {
            'data': data,
            'command': command,
            'stdout': stdout,
            'stderr': stderr,
            'returncode': returncode
        }
    except Exception as e:
        print(f"Error fetching tensorboard data: {e}")
        return {
            'data': None,
            'command': command if 'command' in locals() else '',
            'stdout': '',
            'stderr': str(e),
            'returncode': 1
        }

def fetch_nvidia_smi():
    """Fetch GPU metrics from nvidia-smi"""
    global nvidia_smi_data
    try:
        command = "nvidia-smi --query-gpu=temperature.gpu,power.draw,memory.used,memory.total --format=csv,noheader,nounits"
        stdout, stderr, returncode = run_ssh_command(command)
        
        if returncode != 0:
            print(f"Error fetching nvidia-smi data: {stderr}")
            return {
                'command': command,
                'stdout': stdout,
                'stderr': stderr,
                'returncode': returncode
            }
        
        output = stdout.strip()
        if output:
            values = output.split(',')
            temp = float(values[0].strip())
            power = float(values[1].strip())
            mem_used = float(values[2].strip())
            mem_total = float(values[3].strip())
            
            with data_lock:
                nvidia_smi_data['timestamps'].append(datetime.now().isoformat())
                nvidia_smi_data['temperature'].append(temp)
                nvidia_smi_data['power'].append(power)
                nvidia_smi_data['memory_used'].append(mem_used)
                nvidia_smi_data['memory_total'].append(mem_total)
                
                # Keep only last 100 data points
                if len(nvidia_smi_data['timestamps']) > 100:
                    for key in nvidia_smi_data:
                        nvidia_smi_data[key] = nvidia_smi_data[key][-100:]
        
        return {
            'command': command,
            'stdout': stdout,
            'stderr': stderr,
            'returncode': returncode
        }
    except Exception as e:
        print(f"Error fetching nvidia-smi data: {e}")
        return {
            'command': command if 'command' in locals() else '',
            'stdout': '',
            'stderr': str(e),
            'returncode': 1
        }

def tensorboard_monitor_thread(experiment_path):
    """Thread function to monitor tensorboard data every 30 seconds"""
    global monitoring_active
    while monitoring_active:
        result = fetch_tensorboard_data(experiment_path)
        if result and result.get('returncode') != 0:
            print(f"Error in tensorboard monitoring: {result.get('stderr')}")
        time.sleep(30)

def nvidia_smi_monitor_thread():
    """Thread function to monitor nvidia-smi every 10 seconds"""
    global monitoring_active
    while monitoring_active:
        result = fetch_nvidia_smi()
        if result and result.get('returncode') != 0:
            print(f"Error in nvidia-smi monitoring: {result.get('stderr')}")
        time.sleep(10)

@app.route('/')
def index():
    """Main page"""
    return render_template('index.html')

@app.route('/api/experiments')
def get_experiments():
    """API endpoint to get list of tensorboard experiments"""
    try:
        # Find all directories containing tensorboard event files recursively
        command = f'find {TENSORBOARD_LOGS_PATH} -type f -name "events.out.tfevents.*" -exec dirname {{}} \\; | sort -u'
        stdout, stderr, returncode = run_ssh_command(command)
        
        experiments = stdout.strip().split('\n') if stdout else []
        experiments = [exp for exp in experiments if exp]
        
        return jsonify({
            'experiments': experiments,
            'command': command,
            'stdout': stdout,
            'stderr': stderr,
            'returncode': returncode
        })
    except Exception as e:
        return jsonify({
            'experiments': [],
            'error': str(e),
            'command': command if 'command' in locals() else '',
            'stdout': '',
            'stderr': str(e),
            'returncode': 1
        })

@app.route('/api/tensorboard/<path:experiment_path>')
def get_tensorboard_data(experiment_path):
    """API endpoint to get tensorboard data for a specific experiment"""
    # Normalize path by removing leading slash for consistent dictionary keys
    normalized_path = experiment_path.lstrip('/')
    
    with data_lock:
        # Debug: print what we're looking for and what we have
        print(f"Looking for experiment: {experiment_path} (normalized: {normalized_path})")
        print(f"Available keys in tensorboard_data: {list(tensorboard_data.keys())}")
        
        data = tensorboard_data.get(normalized_path, {})
        
        if not data:
            print(f"No data found for {normalized_path}")
        else:
            print(f"Found data with {len(data)} metrics")
    
    return jsonify(data)

@app.route('/api/nvidia-smi')
def get_nvidia_smi_data():
    """API endpoint to get nvidia-smi data"""
    try:
        # Fetch fresh nvidia-smi data
        result = fetch_nvidia_smi()
        
        with data_lock:
            data = nvidia_smi_data.copy()
        
        return jsonify({
            **data,
            'command': result.get('command', ''),
            'raw_output': result.get('stdout', ''),
            'stderr': result.get('stderr', ''),
            'returncode': result.get('returncode', 1)
        })
    except Exception as e:
        with data_lock:
            data = nvidia_smi_data.copy()
        return jsonify({
            **data,
            'error': str(e),
            'command': '',
            'raw_output': '',
            'stderr': str(e),
            'returncode': 1
        })

@app.route('/api/start-monitoring', methods=['POST'])
def start_monitoring():
    """Start monitoring threads"""
    global monitoring_active, monitoring_threads
    
    if monitoring_active:
        return jsonify({'status': 'already_running', 'output': 'Monitoring already active'})
    
    data = request.json
    experiment_path = data.get('experiment_path')
    
    outputs = []
    
    # First, sync the tensorboard extraction script
    try:
        remote_dir = os.path.dirname(REMOTE_SCRIPT_PATH)
        mkdir_command = f'mkdir -p {remote_dir}'
        stdout, stderr, returncode = run_ssh_command(mkdir_command)
        outputs.append(f"$ {mkdir_command}\n{stdout}{stderr}")
        
        rsync_command, rsync_stdout, rsync_stderr, rsync_returncode = run_rsync(
            TENSORBOARD_SCRIPT_PATH,
            REMOTE_SCRIPT_PATH,
            remote_to_local=False
        )
        outputs.append(f"$ {rsync_command}\n{rsync_stdout}{rsync_stderr}")
        
        if rsync_returncode != 0:
            return jsonify({
                'status': 'error',
                'message': 'Failed to sync tensorboard script',
                'output': '\n'.join(outputs)
            })
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e),
            'output': '\n'.join(outputs) + f"\nError: {str(e)}"
        })
    
    monitoring_active = True
    monitoring_threads = []
    
    # Perform initial data fetches before starting background threads
    # This ensures data is immediately available when frontend starts polling
    
    # Initial nvidia-smi fetch
    nvidia_result = fetch_nvidia_smi()
    if nvidia_result and nvidia_result.get('returncode') == 0:
        outputs.append("Initial GPU metrics fetched successfully")
    
    # Initial tensorboard fetch if experiment specified
    if experiment_path:
        tb_result = fetch_tensorboard_data(experiment_path)
        if tb_result and tb_result.get('returncode') == 0:
            outputs.append(f"Initial tensorboard data fetched for: {experiment_path}")
        else:
            outputs.append(f"Warning: Could not fetch initial tensorboard data: {tb_result.get('stderr', 'Unknown error')}")
    
    # Start nvidia-smi monitoring thread
    nvidia_thread = threading.Thread(target=nvidia_smi_monitor_thread, daemon=True)
    nvidia_thread.start()
    monitoring_threads.append(nvidia_thread)
    outputs.append("Started nvidia-smi monitoring thread (10s interval)")
    
    # Start tensorboard monitoring thread if experiment specified
    if experiment_path:
        tb_thread = threading.Thread(target=tensorboard_monitor_thread, args=(experiment_path,), daemon=True)
        tb_thread.start()
        monitoring_threads.append(tb_thread)
        outputs.append(f"Started tensorboard monitoring thread (30s interval) for: {experiment_path}")
    
    return jsonify({
        'status': 'started',
        'output': '\n'.join(outputs)
    })

@app.route('/api/stop-monitoring', methods=['POST'])
def stop_monitoring():
    """Stop monitoring threads"""
    global monitoring_active
    monitoring_active = False
    return jsonify({'status': 'stopped'})

@app.route('/api/sync-images', methods=['POST'])
def sync_images():
    """Sync images from remote machine using rsync"""
    try:
        command_str, stdout, stderr, returncode = run_rsync(
            IMAGE_SAMPLES_PATH + '/',
            LOCAL_IMAGES_PATH,
            remote_to_local=True
        )
        
        output = f"$ {command_str}\n{stdout}{stderr}"
        
        if returncode == 0:
            # List synced images
            images = []
            for root, dirs, files in os.walk(LOCAL_IMAGES_PATH):
                for file in files:
                    if file.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp')):
                        rel_path = os.path.relpath(os.path.join(root, file), LOCAL_IMAGES_PATH)
                        images.append(rel_path)
            
            return jsonify({
                'status': 'success',
                'images': images,
                'output': output,
                'returncode': returncode
            })
        else:
            return jsonify({
                'status': 'error',
                'message': stderr,
                'output': output,
                'returncode': returncode
            })
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e),
            'output': f"Error: {str(e)}",
            'returncode': 1
        })

@app.route('/api/images')
def list_images():
    """List all synced images"""
    images = []
    for root, dirs, files in os.walk(LOCAL_IMAGES_PATH):
        for file in files:
            if file.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp')):
                rel_path = os.path.relpath(os.path.join(root, file), LOCAL_IMAGES_PATH)
                images.append(rel_path)
    return jsonify({'images': images})

@app.route('/images/<path:filename>')
def serve_image(filename):
    """Serve synced images"""
    return send_from_directory(LOCAL_IMAGES_PATH, filename)

@app.route('/api/sync-output', methods=['POST'])
def sync_output():
    """Sync main thread output from remote machine"""
    try:
        command_str, stdout, stderr, returncode = run_rsync(
            MAIN_THREAD_OUTPUT,
            LOCAL_OUTPUT_PATH,
            remote_to_local=True
        )
        
        output = f"$ {command_str}\n{stdout}{stderr}"
        
        if returncode == 0:
            return jsonify({
                'status': 'success',
                'output': output,
                'returncode': returncode
            })
        else:
            return jsonify({
                'status': 'error',
                'message': stderr,
                'output': output,
                'returncode': returncode
            })
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e),
            'output': f"Error: {str(e)}",
            'returncode': 1
        })

@app.route('/api/output')
def get_output():
    """Get the synced output file content"""
    try:
        if os.path.exists(LOCAL_OUTPUT_PATH):
            with open(LOCAL_OUTPUT_PATH, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            return jsonify({
                'status': 'success',
                'content': content
            })
        else:
            return jsonify({
                'status': 'error',
                'message': 'Output file not found. Please sync first.'
            })
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        })

if __name__ == '__main__':
    app.run(debug=False, host='localhost', port=5000)
