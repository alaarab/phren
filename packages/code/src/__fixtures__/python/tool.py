"""Small helpers for the fixture project."""


def greet(name):
    """Return a greeting for name."""
    return "hi " + name


class Greeter:
    """Greets people by name."""

    def hello(self, name):
        return greet(name)

    def twice(self, name):
        return greet(name) + greet(name)
