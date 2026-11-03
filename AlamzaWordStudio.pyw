"""Double-click (or use the Start Menu shortcut) to launch Alamza Word Studio in the system tray."""
import multiprocessing
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

if __name__ == "__main__":
    multiprocessing.freeze_support()
    from wordstudio.app import main

    main()
