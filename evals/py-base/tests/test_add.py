from src.calc import add


def test_adds():
    assert add(1, 1) == 2


def test_adds_negatives():
    assert add(-1, -1) == -2
