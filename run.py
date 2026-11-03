"""Console launcher (shows logs). Use --no-tray to run as a plain server."""
import multiprocessing
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

if __name__ == "__main__":
    multiprocessing.freeze_support()
    from wordstudio.app import main

    main()
