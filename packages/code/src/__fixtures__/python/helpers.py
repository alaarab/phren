from tool import greet

LIMIT = 3


def twice(name):
    """Call greet twice."""
    return greet(name) + greet(name)
