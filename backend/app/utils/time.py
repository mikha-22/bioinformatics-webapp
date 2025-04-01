# backend/app/utils/time.py
import datetime
from typing import Optional

def dt_to_timestamp(dt: Optional[datetime.datetime]) -> Optional[float]:
    """Converts a datetime object to a Unix timestamp (float), handling None."""
    return dt.timestamp() if dt else None
