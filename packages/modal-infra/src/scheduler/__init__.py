"""Scheduled tasks for Open-Inspect."""

# Import to register with app (uses lazy imports internally)
from . import image_builder

__all__ = ["image_builder"]
